//! Read-only connectivity check: handshake, subscribe, print the snapshot's
//! shape, disconnect. Sends nothing that changes daemon state.
use nebula_core::codec::{read_frame, write_frame};
use nebula_core::{paths, ClientRequest, ServerEvent, PROTOCOL_VERSION};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut s = tokio::net::UnixStream::connect(paths::socket_path()).await?;
    write_frame(&mut s, &ClientRequest::Hello { protocol_version: PROTOCOL_VERSION }).await?;
    println!("hello: {:?}", read_frame::<ServerEvent, _>(&mut s).await?);
    write_frame(&mut s, &ClientRequest::Subscribe).await?;
    if let Some(ServerEvent::Snapshot { projects, worktrees, agents, terminals, .. }) =
        read_frame::<ServerEvent, _>(&mut s).await?
    {
        println!("{} projects, {} worktrees, {} agents, {} terminals", projects.len(), worktrees.len(), agents.len(), terminals.len());
        for p in &projects {
            let n = worktrees.iter().filter(|w| w.project_id == p.id).count();
            println!("  {} ({n} worktrees)", p.name);
        }
        for a in agents.iter().filter(|a| !a.archived).take(8) {
            println!("  agent {:<28} {:?} alive={}", a.name, a.status, a.alive);
        }
    }
    Ok(())
}
