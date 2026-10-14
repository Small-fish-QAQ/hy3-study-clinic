import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const deny = () => {
  throw new Error('SIMPLIFICATION_AUDIT_NETWORK_DENIED');
};
globalThis.fetch = deny;
for (const [surface, key] of [
  [http, 'request'],
  [http, 'get'],
  [https, 'request'],
  [https, 'get'],
  [net, 'connect'],
  [net, 'createConnection'],
  [tls, 'connect'],
])
  surface[key] = deny;
net.Socket.prototype.connect = deny;
