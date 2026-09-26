import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/onest";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
