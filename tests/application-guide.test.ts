import { it, expect } from "bun:test";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

it("builds the actual application guide, checks its types and per-user handlers without cloud writes", async () => {
  const guide = await readFile(resolve("docs/build-an-app.md"), "utf8");
  const template = await readFile(resolve("docs/templates/AGENTS.md"), "utf8");
  const version = JSON.parse(
    await readFile(resolve("packages/flare/package.json"), "utf8"),
  ).version;
  expect(guide).toContain(`@auersperg/flare@${version}`);
  expect(template).toContain(`@auersperg/flare@${version}`);
  const parent = resolve(".flare");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "application-guide-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"type":"module","private":true}',
    );
    const examples = [
      ...guide.matchAll(
        /```tsx?\n\/\/ ((?:flare|src)\/[^\n]+)\n([\s\S]*?)\n```/g,
      ),
    ];
    expect(examples.map((match) => match[1]).sort()).toEqual([
      "flare/_model.ts",
      "flare/schema.ts",
      "flare/tasks.ts",
      "src/Tasks.tsx",
      "src/flare-client.ts",
    ]);
    for (const [, path, source] of examples) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), source);
    }
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          jsx: "react-jsx",
          types: ["react"],
          lib: ["ES2022", "DOM"],
        },
        include: ["flare/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
      }),
    );
    const script = `
      import assert from 'node:assert/strict';
      import {prepare,generateApi} from ${JSON.stringify(resolve("packages/flare/src/cli/project.mjs"))};
      import {buildApplication} from ${JSON.stringify(resolve("packages/flare/src/cli/build.mjs"))};
      import {readFile} from 'node:fs/promises';
      globalThis.fetch=async()=>{throw Error('Documentation tests must not use the network');};
      const source=await prepare();await buildApplication({...source,outdir:'release'});await generateApi('release');
      const manifest=JSON.parse(await readFile('release/manifest.json','utf8'));
      assert.deepEqual(Object.keys(manifest.functions).sort(),['tasks/create','tasks/list','tasks/setDone']);
      for(const fn of Object.values(manifest.functions))assert.equal(fn.auth,'required');
      const {create,list,setDone}=await import('./flare/tasks.ts');
      const {taskFields,subject}=await import('./flare/_model.ts');
      const auth={subject:'alice',issuer:'fixture',expiresAt:9999999999,claims:{}};
      const inserted=[];const patches=[];const queries=[];
      const db={
        insert:async(table,value)=>{assert.equal(table,'tasks');inserted.push(taskFields.parse(value));return 'task-1';},
        get:async(table,id)=>{assert.equal(table,'tasks');return id==='missing'?null:{_id:id,_creationTime:1,owner:id==='foreign'?'bob':'alice',title:'Example',done:false};},
        patch:async(...args)=>{patches.push(args);},
        query:table=>({withIndex:(index,condition)=>{assert.equal(table,'tasks');assert.equal(index,'by_owner');condition({eq:(field,value)=>{queries.push([field,value]);}});return {order:direction=>{assert.equal(direction,'desc');return {paginate:async args=>({page:[],continueCursor:null,isDone:true})};}};}}),
      };
      assert.throws(()=>subject(null),e=>e.code==='UNAUTHORIZED');
      assert.equal(await create.handler({db,auth},create.input.parse({title:'  Own task  ',owner:'bob'})),'task-1');
      assert.deepEqual(inserted,[{owner:'alice',title:'Own task',done:false}]);
      await assert.rejects(async()=>create.handler({db,auth:null},{title:'Blocked'}),e=>e.code==='UNAUTHORIZED');
      assert.equal(inserted.length,1);
      assert.equal(create.input.safeParse({title:' '}).success,false);
      assert.equal(create.input.safeParse({title:'x'.repeat(201)}).success,false);
      assert.equal(list.input.safeParse({limit:51}).success,false);
      const page=await list.handler({db,auth},list.input.parse({}));list.output.parse(page);
      assert.deepEqual(queries,[['owner','alice']]);
      assert.throws(()=>list.handler({db,auth:null},list.input.parse({})),e=>e.code==='UNAUTHORIZED');
      for(const id of ['foreign','missing'])await assert.rejects(setDone.handler({db,auth},{id,done:true}),e=>e.code==='FORBIDDEN');
      await assert.rejects(setDone.handler({db,auth:null},{id:'owned',done:true}),e=>e.code==='UNAUTHORIZED');
      assert.equal(patches.length,0);
      assert.equal(await setDone.handler({db,auth},{id:'owned',done:true}),null);
      assert.deepEqual(patches,[['tasks','owned',{done:true}]]);
      const api=await import('./flare/_generated/api.ts');assert.equal(api.api.tasks.list.path,'tasks/list');
      const frontend=await Bun.build({entrypoints:['src/Tasks.tsx','src/flare-client.ts'],target:'browser',outdir:'frontend'});
      assert.equal(frontend.success,true,JSON.stringify(frontend.logs));
      console.log('PASS documentation build, browser imports and ownership');
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, FLARE_DEPLOY_TOKEN: "" },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const types = spawnSync(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--project",
        "tsconfig.json",
      ],
      { cwd: directory, encoding: "utf8", timeout: 30000 },
    );
    expect(types.status, types.stdout + types.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
