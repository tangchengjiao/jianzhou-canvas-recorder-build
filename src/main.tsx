import "./polyfills";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(<App />);
