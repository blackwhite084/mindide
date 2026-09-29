import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.tsx";
import { client } from "./client.ts";

client.connect();
createRoot(document.getElementById("root")!).render(<App />);
