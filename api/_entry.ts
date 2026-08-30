import { createServer } from "node:http";

import { createApp } from "../src/server";
import { attachTelephonyWebSockets } from "../src/telephony/routes";

const app = createApp();
const server = createServer(app);

attachTelephonyWebSockets(server, {
  store: app.locals.operationStore,
  dialled: app.locals.telephonyDialled,
  onCallSessionChanged: (session, organizationId) =>
    void app.locals.saveCallSession(session, organizationId),
  resolveCallContext: (reference) =>
    app.locals.resolveTelephonyCallContext(reference)
});

export default server;
