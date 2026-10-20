/** The basin solve off the main thread (a solve takes tens of ms; craters re-solve while they are pending). */
import { runBasinJob, type BasinJob } from './basin-job';

self.onmessage = (event: MessageEvent<BasinJob>) => {
  const r = runBasinJob(event.data);
  self.postMessage(r, { transfer: [r.labels.buffer, r.bed.buffer] });
};
