import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Private fixture transport only. The scope/email are compiled in; no operator
// impersonation, arbitrary forwarding, secret reads or production fault hooks.
export async function prepareFeatureProof({
  state,
  release,
  scratch,
  project,
  email,
}) {
  const name =
    state.workers.runtime.name.replace(/-runtime$/, "-features-") +
    project.slice(0, 8);
  const main = join(scratch, "features.mjs"),
    config = join(scratch, "features.json"),
    secretsFile = join(scratch, "features-key.json");
  const key = randomUUID() + randomUUID();
  await writeFile(
    main,
    `const project=${JSON.stringify(project)},email=${JSON.stringify(email)};
export default {async fetch(req,env){
if(req.headers.get("authorization")!=="Bearer "+env.KEY)return new Response("Unauthorized",{status:401});
const u=new URL(req.url),which=u.searchParams.get("env")??"dev";
if(!["dev","prod"].includes(which))return new Response("Invalid",{status:400});
const scope=project+"/"+which;
if(u.pathname==="/ready")return Response.json({ready:project});
if(u.pathname.startsWith("/runtime/")){const path=u.pathname.slice(8);if(path!=="/health"&&!path.startsWith("/p/"+project+"/"))return new Response("Forbidden",{status:403});u.pathname=path;const headers=new Headers(req.headers);headers.delete("authorization");return env.PUBLIC_RUNTIME.fetch(new Request(new Request(u,req),{headers}));}
if(u.pathname==="/live")return env.RUNTIME.fetch(new Request("https://dashboard.internal/"+scope,{headers:{upgrade:"websocket","x-flared-dashboard":JSON.stringify({email,expires:Date.now()+60000})}}));
if(req.method!=="POST"||u.pathname!=="/command")return new Response("Not found",{status:404});
const {op,input}=await req.json(); let args;
if(op==="configure")args=[{scope,origins:[],oidc:null}];
else if(op==="deploy")args=[scope,input];
else if(["health","edit","backup-list","backup-create","backup-delete","auth-create","auth-configure","file-upload","file-delete"].includes(op))args=[scope,op,input??{}];
else return new Response("Invalid",{status:400});
const r=await env.RUNTIME.command(["configure","deploy"].includes(op)?op:"admin",args);
return Response.json(r,{status:r.ok?200:409});
}};`,
  );
  await writeFile(
    config,
    JSON.stringify({
      name,
      account_id: state.account,
      main,
      find_additional_modules: false,
      compatibility_date: release.manifest.compatibilityDate,
      workers_dev: true,
      preview_urls: false,
      services: [
        {
          binding: "RUNTIME",
          service: state.workers.runtime.name,
          entrypoint: "RuntimeControl",
        },
        { binding: "PUBLIC_RUNTIME", service: state.workers.runtime.name },
      ],
    }),
    { mode: 0o600 },
  );
  await writeFile(secretsFile, JSON.stringify({ KEY: key }), { mode: 0o600 });
  return { name, config, key, secretsFile };
}

export function connectProofSocket(url, key) {
  const frames = [];
  let closed;
  const ws = new WebSocket(url, {
    headers: { authorization: "Bearer " + key },
  });
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  ws.onclose = (e) => {
    closed = { code: e.code, reason: e.reason };
  };
  ws.onerror = () => {};
  return {
    ws,
    frames,
    get closed() {
      return closed;
    },
  };
}
export async function waitProof(check, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw Error("Feature proof timed out");
}
