// A worker that answers with something that is not a result.
import { parentPort } from "node:worker_threads";
parentPort!.postMessage("nonsense");
setInterval(() => {}, 1000);
