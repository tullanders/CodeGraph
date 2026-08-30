import { renderPdf } from "../../../packages/core/src/core.js";

export function handleRequest() {
  return renderPdf("faktura");
}
