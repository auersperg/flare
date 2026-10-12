import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { it, expect } from "bun:test";
async function temporaryCli(prefix: string) {
  const parent = join(process.cwd(), ".flare");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}
it("discovers schema/functions and generates typed API/server without SQL journals", async () => {
  const dir = await temporaryCli("cli-proof-");
  try {
    const script = `
 import {prepare,generateApi,frontendEnvironment} from ${JSON.stringify(resolve("packages/flare/src/cli/project.mjs"))};
 import {buildApplication} from ${JSON.stringify(resolve("packages/flare/src/cli/build.mjs"))};
 import {writeFile,readFile,mkdir,access} from 'node:fs/promises'; import assert from 'node:assert/strict';
 await writeFile('package.json','{"type":"module","private":true,"dependencies":{"astro":"7.3.8"}}');await mkdir('flare');
 await writeFile('flare/schema.ts','import {defineSchema,defineTable,z} from "@auersperg/flare/server";export default defineSchema({notes:defineTable(z.object({title:z.string()})).index("by_title",["title"])});');
 await writeFile('flare/notes.ts','import {query} from "./_generated/server";import {z} from "@auersperg/flare/server";export const list=query({auth:"public",input:z.object({}),output:z.array(z.object({_id:z.string(),_creationTime:z.number(),title:z.string()})),handler:({db})=>db.query("notes").take(50)});');
 await writeFile('flare/queries.ts', 'import {query} from "./_generated/server";import {z} from "@auersperg/flare/server";export const only=query({input:z.object({}),output:z.string(),handler:()=>"QUERY_HANDLER_SHOULD_NOT_ENTER_ACTION_RUNTIME"});');
 await writeFile('flare/actions.ts', 'import {action} from "./_generated/server";import {z} from "@auersperg/flare/server";export const only=action({input:z.object({}),output:z.string(),handler:()=>"ACTION_HANDLER_IS_PRESENT"});');
 const source=await prepare();await buildApplication({...source,outdir:'release1'});await generateApi('release1');
 const actionCode=await readFile('release1/action.js','utf8');assert(actionCode.includes('ACTION_HANDLER_IS_PRESENT'));assert(!actionCode.includes('QUERY_HANDLER_SHOULD_NOT_ENTER_ACTION_RUNTIME'));
 assert((await readFile('release1/facet.js','utf8')).includes('QUERY_HANDLER_SHOULD_NOT_ENTER_ACTION_RUNTIME'));
 assert.equal(JSON.parse(await readFile('release1/manifest.json','utf8')).runtimeAbi,4);
 assert.equal(JSON.parse(await readFile('release1/schema.json','utf8')).notes.document.properties.title.type,'string');
 const api=await readFile('flare/_generated/api.ts','utf8');assert(api.includes('"notes":')&&api.includes('"list":'));
 assert((await readFile('flare/_generated/server.ts','utf8')).includes('createFunctions<typeof schema>'));
 await assert.rejects(access('flare/migrations'));await prepare();
 await writeFile('.env.local','OTHER=value\\n');await frontendEnvironment('https://api.example.test/test/dev');await frontendEnvironment('https://api.example.test/test/dev');
 const env=await readFile('.env.local','utf8');assert(env.startsWith('OTHER=value\\n'));assert.equal((env.match(/PUBLIC_FLARE_URL=/g)||[]).length,1);assert(!env.includes('TOKEN'));
 console.log('PASS native flow');`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: dir, encoding: "utf8", timeout: 60000 },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("PASS native flow");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
it("backup CLI is explicit, project-scoped and never retries writes", async () => {
  const directory = await temporaryCli("backup-cli-");
  try {
    const source = `
      import {backup} from ${JSON.stringify(resolve("packages/flare/src/cli/cloud.mjs"))};
      import {mkdir,writeFile} from 'node:fs/promises'; import assert from 'node:assert/strict';
      const project='00000000-0000-4000-8000-000000000001', id='00000000-0000-4000-8000-000000000002';
      await mkdir('.flare'); await writeFile('.flare/project.json',JSON.stringify({project,platform:'https://api.example.test/control'}));
      const calls=[]; globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({ok:true});};
      await backup({operation:'list',env:'dev'});assert(calls[0].url.endsWith('/dev/backups'));
      await assert.rejects(backup({operation:'restore',env:'prod',from:'prod',id,confirm:project}));assert.equal(calls.length,1);
      await assert.rejects(backup({operation:'restore',env:'prod',from:'dev',id}));assert.equal(calls.length,1);
      await backup({operation:'restore',env:'prod',from:'dev',id,confirm:project});
      assert.deepEqual(JSON.parse(calls[1].init.body),{id,sourceEnv:'dev',confirm:project});
      let failures=0;globalThis.fetch=async()=>{failures++;throw Error('Lost acknowledgement');};
      await assert.rejects(backup({operation:'create',env:'dev',id,confirm:project}));assert.equal(failures,1);
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, FLARE_DEPLOY_TOKEN: "synthetic-test-token" },
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("release build hook uses target URL, preserves dev env and never publishes after a failed build", async () => {
  const directory = await temporaryCli("release-cli-");
  try {
    const source = `
 import {deploy,promote,rollback} from ${JSON.stringify(resolve("packages/flare/src/cli/cloud.mjs"))};
 import {mkdir,writeFile,readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
 const project='00000000-0000-4000-8000-000000000001',hash='b'.repeat(64),active='a'.repeat(64);
 await mkdir('.flare');await writeFile('.flare/project.json',JSON.stringify({project,platform:'https://api.example.test/control'}));
 await writeFile('.env.local','PUBLIC_FLARE_URL=https://api.example.test/app/dev\\n');
 await mkdir('release');const bundle={release:{hash},manifest:{functions:{}},schema:{},facet:'code',action:'code'};
 for(const [key,value] of Object.entries(bundle))await writeFile('release/'+key+(key==='facet'||key==='action'?'.js':'.json'),typeof value==='string'?value:JSON.stringify(value));
 await writeFile('release/api.ts','export const api={};');
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json(url.includes('/settings')?{url:'https://api.example.test/app/prod'}:url.includes('/health')?{active}:url.includes('/release-bundle')?bundle:{hash});};
 await deploy({env:'prod',release:'release',confirm:project,cmd:'bun -e \\'await Bun.write("built-url",process.env.PUBLIC_FLARE_URL)\\''});
 assert.equal(await readFile('built-url','utf8'),'https://api.example.test/app/prod');assert((await readFile('.env.local','utf8')).endsWith('/dev\\n'));
 assert.equal(calls.filter(c=>c.init.method==='POST').length,1);
 await writeFile('flare/_generated/api.ts','PREVIOUS_API');await writeFile('flare/_generated/references.ts','PREVIOUS_REFERENCES');
 calls.length=0;await assert.rejects(deploy({env:'prod',release:'release',confirm:project,cmd:'exit 13'}));assert.equal(calls.filter(c=>c.init.method==='POST').length,0);
 assert.equal(await readFile('flare/_generated/api.ts','utf8'),'PREVIOUS_API');assert.equal(await readFile('flare/_generated/references.ts','utf8'),'PREVIOUS_REFERENCES');
 calls.length=0;await deploy({env:'prod',release:'release',confirm:project});assert.deepEqual(JSON.parse(calls.at(-1).init.body),{bundle,confirm:project,expected:active});
 const gateway=globalThis.fetch;calls.length=0;globalThis.fetch=async(url,init)=>{calls.push({url,init});if(init.method==='GET')return Response.json({active});assert.equal(JSON.parse(init.body).expected,active);return Response.json({error:'CONFLICT'},{status:409});};
 await assert.rejects(deploy({env:'prod',release:'release',confirm:project}),e=>e.status===409&&!e.ambiguous);assert.equal(calls.filter(c=>c.init.method==='POST').length,1);globalThis.fetch=gateway;
 calls.length=0;await promote({hash,confirm:project});assert.equal(calls.at(-1).url.endsWith('/prod/release-promote'),true);assert.deepEqual(JSON.parse(calls.at(-1).init.body),{hash,expected:active,confirm:project});
 await assert.rejects(promote({hash,env:'dev',confirm:project}));
 calls.length=0;await rollback({hash,env:'dev',confirm:project});assert.equal(calls.at(-1).url.endsWith('/dev/release-rollback'),true);
 `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, FLARE_DEPLOY_TOKEN: "synthetic-test-token" },
        timeout: 30000,
      },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("management errors retain HTTP status and flag unknown writes without retries", async () => {
  const directory = await temporaryCli("management-cli-");
  try {
    const source = `
      import {backup,releases} from ${JSON.stringify(resolve("packages/flare/src/cli/cloud.mjs"))};
      import {mkdir,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
      const project='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
      await mkdir('.flare');await writeFile('.flare/project.json',JSON.stringify({project,platform:'https://api.example.test/control'}));
      let count=0;globalThis.fetch=async()=>{count++;return new Response('<html>Private gateway details</html>',{status:401});};
      await assert.rejects(releases({env:'dev'}),e=>e.status===401&&!e.ambiguous&&!e.message.includes('Private gateway details'));assert.equal(count,1);
      count=0;globalThis.fetch=async()=>{count++;throw Error('Disconnected with private request details');};
      await assert.rejects(backup({operation:'create',env:'dev',id,confirm:project}),e=>e.ambiguous===true&&/outcome is unknown/.test(e.message)&&!e.message.includes('private request details'));assert.equal(count,1);
      count=0;globalThis.fetch=async()=>{count++;return new Response('truncated',{status:200});};
      await assert.rejects(backup({operation:'create',env:'dev',id,confirm:project}),e=>e.status===200&&e.ambiguous===true);assert.equal(count,1);
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, FLARE_DEPLOY_TOKEN: "synthetic-test-token" },
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("invalid or unconfirmed deploys do not scaffold or execute application code", async () => {
  const directory = await temporaryCli("invalid-deploy-");
  try {
    const source = `
      import {deploy} from ${JSON.stringify(resolve("packages/flare/src/cli/cloud.mjs"))};
      import {mkdir,writeFile,access} from 'node:fs/promises';import assert from 'node:assert/strict';
      await writeFile('package.json','{"type":"module","private":true}');await mkdir('.flare');
      await writeFile('.flare/project.json',JSON.stringify({project:'00000000-0000-4000-8000-000000000001',platform:'https://api.example.test/control'}));
      await assert.rejects(deploy({env:'staging'}),/Environment must be dev or prod/);await assert.rejects(access('flare'));
      await assert.rejects(deploy({env:'prod'}),/Production requires/);await assert.rejects(access('flare'));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("failed client-contract staging preserves absent files and unrelated generated code", async () => {
  const directory = await temporaryCli("client-contract-");
  try {
    const source = `
      import {withGeneratedApi} from ${JSON.stringify(resolve("packages/flare/src/cli/project.mjs"))};
      import {mkdir,writeFile,readFile,access} from 'node:fs/promises';import assert from 'node:assert/strict';
      await mkdir('release');await writeFile('release/manifest.json','{"functions":{}}');await writeFile('release/api.ts','CANDIDATE_REFERENCES');
      await mkdir('flare/_generated',{recursive:true});await writeFile('flare/_generated/server.ts','UNCHANGED_SERVER_TYPES');
      await assert.rejects(withGeneratedApi('release',async()=>{assert.equal(await readFile('flare/_generated/references.ts','utf8'),'CANDIDATE_REFERENCES');throw Error('Frontend failed');}),/Frontend failed/);
      await assert.rejects(access('flare/_generated/api.ts'));await assert.rejects(access('flare/_generated/references.ts'));
      assert.equal(await readFile('flare/_generated/server.ts','utf8'),'UNCHANGED_SERVER_TYPES');
      assert.equal(await withGeneratedApi('release',async()=>42),42);assert.equal(await readFile('flare/_generated/references.ts','utf8'),'CANDIDATE_REFERENCES');
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
