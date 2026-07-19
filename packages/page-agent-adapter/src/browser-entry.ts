import { PageAgent } from "page-agent";

declare global {
  interface Window {
    FlowTestPageAgent: typeof PageAgent;
  }
}

window.FlowTestPageAgent = PageAgent;
