import { formatMessage } from "./format.js";

export class Application {
  start() {
    return formatMessage("ready");
  }
}

export function start() {
  return formatMessage("ready");
}