import "./preview.css";
import { suffix } from "virtual:suffix";

declare const process: { env: Record<string, string | undefined> };

document.body.append(Object.assign(document.createElement("h1"), { textContent: `${process.env.GREETING ?? "no define"} ${suffix}` }));
