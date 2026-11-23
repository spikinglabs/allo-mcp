import { createGateway } from "./gateway.js";
import { UPSTREAMS } from "./upstreams.js";

// One gateway per isolate, so the tool-list cache is shared across requests.
const gateway = createGateway(UPSTREAMS);

export default {
  fetch: (request) => gateway.handle(request),
};
