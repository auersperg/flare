// Explicit operator-only proof cleanup. Scopes are compiled in, never supplied by callers.
import { randomBytes, randomUUID } from "node:crypto";
export async function cleanupCloudScopes({ account, oauth, scopes }) {
  if (
    !scopes.length ||
    scopes.some((s) => !/^[0-9a-f-]{36}\/(dev|prod)$/.test(s))
  )
    throw Error("Invalid disposable scopes");
  const name = "flared-cleanup-proof-" + randomUUID().slice(0, 8);
  const key = randomBytes(32).toString("hex");
  async function cf(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(`${account}/${path}`, {
      method,
      headers: {
        authorization: "Bearer " + oauth,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!result.success) throw Error(JSON.stringify(result.errors));
    return result.result;
  }
  const source = `export default {async fetch(req,env){if(req.method!=="POST"||req.headers.get("authorization")!=="Bearer "+env.KEY)return new Response("Unauthorized",{status:401});for(const op of ["prepareDestroy","destroy"])for(const scope of ${JSON.stringify(scopes)}){const r=await env.RUNTIME.command(op,[scope]);if(!r.ok)return Response.json({error:r.code},{status:409});}return Response.json({cleaned:true});}}`;
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: "proof.js",
      compatibility_date: "2026-10-10",
      bindings: [
        {
          type: "service",
          name: "RUNTIME",
          service: "flared-runtime",
          entrypoint: "RuntimeControl",
        },
        { type: "secret_text", name: "KEY", text: key },
      ],
    }),
  );
  form.set(
    "proof.js",
    new Blob([source], { type: "application/javascript+module" }),
    "proof.js",
  );
  const upload = await fetch(`${account}/workers/scripts/${name}`, {
    method: "PUT",
    headers: { authorization: "Bearer " + oauth },
    body: form,
  });
  const result = await upload.json();
  if (!result.success) throw Error(JSON.stringify(result.errors));
  try {
    await cf(`workers/scripts/${name}/subdomain`, {
      enabled: true,
      previews_enabled: false,
    });
    const domain = (await cf("workers/subdomain")).subdomain;
    let response;
    for (let attempt = 0; attempt < 8; attempt++) {
      response = await fetch(`https://${name}.${domain}.workers.dev`, {
        method: "POST",
        headers: { authorization: "Bearer " + key },
      });
      if (response.status !== 404) break;
      await response.body?.cancel();
      await Bun.sleep(2000);
    }
    if (!response.ok)
      throw Error(
        "Cleanup failed: " +
          response.status +
          " " +
          (await response.text()).slice(0, 400),
      );
    return await response.json();
  } finally {
    await cf(`workers/scripts/${name}`, undefined, "DELETE");
  }
}
