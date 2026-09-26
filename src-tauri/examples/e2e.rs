//! End-to-end check against a SANDBOX daemon (NEBULA_RUNTIME_DIR set, started
//! with NEBULA_AGENT_CMD pointing at a fake agent). Every request is built
//! from the same JSON the webview sends, so this catches shape drift between
//! the TypeScript client and nebula-core.
use nebula_core::codec::{read_frame, write_frame};
use nebula_core::{paths, ClientRequest, ServerEvent, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::net::UnixStream;

type R<T> = Result<T, Box<dyn std::error::Error>>;

async fn send(s: &mut UnixStream, v: Value) -> R<()> {
    let req: ClientRequest = serde_json::from_value(v)?;
    write_frame(s, &req).await?;
    Ok(())
}

/// Read events (as the JSON the webview receives) until `pick` returns Some.
async fn until<T>(s: &mut UnixStream, secs: u64, mut pick: impl FnMut(&Value) -> Option<T>) -> R<T> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let ev = tokio::time::timeout_at(deadline, read_frame::<ServerEvent, _>(s))
            .await
            .map_err(|_| "timed out waiting for event")??
            .ok_or("daemon closed")?;
        let v = serde_json::to_value(&ev)?;
        if let Some(Value::String(msg)) = v.pointer("/Error/message") {
            return Err(format!("daemon error: {msg}").into());
        }
        if let Some(t) = pick(&v) {
            return Ok(t);
        }
    }
}

#[tokio::main]
async fn main() -> R<()> {
    let sock = paths::socket_path();
    assert!(
        std::env::var("NEBULA_RUNTIME_DIR").is_ok(),
        "refusing to run against the real daemon: set NEBULA_RUNTIME_DIR to the sandbox"
    );
    let mut s = UnixStream::connect(&sock).await?;
    write_frame(&mut s, &ClientRequest::Hello { protocol_version: PROTOCOL_VERSION }).await?;
    read_frame::<ServerEvent, _>(&mut s).await?;
    send(&mut s, json!("Subscribe")).await?;
    let project = until(&mut s, 5, |v| {
        v.pointer("/Snapshot/projects/0/id").and_then(Value::as_str).map(String::from)
    })
    .await?;
    println!("ok   snapshot, project {project}");

    let branch = format!("e2e-{}", std::process::id());
    send(&mut s, json!({"CreateWorktree": {"req_id": 1, "project": project, "branch": branch, "base": null}})).await?;
    let wt = until(&mut s, 30, |v| {
        (v.pointer("/Ack/req_id")? == 1)
            .then(|| v.pointer("/Ack/created/Worktree")?.as_str().map(String::from))?
    })
    .await?;
    println!("ok   CreateWorktree -> {wt}");

    send(&mut s, json!({"CreateAgent": {
        "req_id": 2, "worktree": wt, "name": "agent-1", "kind": "claude",
        "custom_harness": null, "model": null, "effort": null, "auto_title": true,
        "cloud_prompt": null, "starting_prompt": "hello from e2e", "issue_url": null
    }}))
    .await?;
    let agent = until(&mut s, 10, |v| {
        (v.pointer("/Ack/req_id")? == 2)
            .then(|| v.pointer("/Ack/created/Agent")?.as_str().map(String::from))?
    })
    .await?;
    println!("ok   CreateAgent -> {agent}");

    let session = json!({"Agent": agent});
    send(&mut s, json!({"Attach": {"session": session, "from_seq": null, "cols": 100, "rows": 30}})).await?;
    until(&mut s, 10, |v| {
        let text = v
            .pointer("/Output/data")
            .or_else(|| v.pointer("/Scrollback/data"))?
            .as_array()?
            .iter()
            .filter_map(|b| b.as_u64().map(|b| b as u8))
            .collect::<Vec<u8>>();
        String::from_utf8_lossy(&text).contains("fake agent").then_some(())
    })
    .await?;
    println!("ok   Attach, saw the agent's output");

    send(&mut s, json!({"Resize": {"session": session, "cols": 120, "rows": 40}})).await?;
    // What sendInput does: the text xterm produced, as bytes.
    let input = ClientRequest::Input {
        session: serde_json::from_value(session.clone())?,
        data: b"ask to edit\r".to_vec(),
    };
    write_frame(&mut s, &input).await?;
    let status = until(&mut s, 15, |v| {
        let sc = v.get("StatusChanged")?;
        (sc.get("agent")?.as_str()? == agent && sc.get("status")?.as_str()? == "needs_feedback")
            .then(|| sc.clone())
    })
    .await?;
    println!("ok   StatusChanged -> needs_feedback {status}");

    let input = ClientRequest::Input {
        session: serde_json::from_value(session.clone())?,
        data: b"y\r".to_vec(),
    };
    write_frame(&mut s, &input).await?;
    until(&mut s, 15, |v| {
        let sc = v.get("StatusChanged")?;
        (sc.get("agent")?.as_str()? == agent && sc.get("status")?.as_str()? == "finished").then_some(())
    })
    .await?;
    println!("ok   reply sent, StatusChanged -> finished");

    send(&mut s, json!({"Detach": {"session": session}})).await?;
    send(&mut s, json!({"RenameAgent": {"req_id": 3, "id": agent, "name": "E2E Renamed"}})).await?;
    until(&mut s, 5, |v| (v.pointer("/Ack/req_id")? == 3).then_some(())).await?;
    println!("ok   RenameAgent");
    send(&mut s, json!({"ArchiveAgent": {"req_id": 4, "id": agent}})).await?;
    until(&mut s, 5, |v| (v.pointer("/Ack/req_id")? == 4).then_some(())).await?;
    println!("ok   ArchiveAgent");
    send(&mut s, json!({"CreateTerminal": {"req_id": 5, "worktree": wt, "name": null}})).await?;
    let term = until(&mut s, 5, |v| {
        (v.pointer("/Ack/req_id")? == 5)
            .then(|| v.pointer("/Ack/created/Terminal")?.as_str().map(String::from))?
    })
    .await?;
    send(&mut s, json!({"CloseTerminal": {"req_id": 6, "id": term}})).await?;
    until(&mut s, 5, |v| (v.pointer("/Ack/req_id")? == 6).then_some(())).await?;
    println!("ok   CreateTerminal / CloseTerminal");
    println!("all passed");
    Ok(())
}
