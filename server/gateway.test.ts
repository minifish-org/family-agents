import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { Gateway } from "./gateway.js";

test("Gateway IPC correlates requests and rejects work safely after child termination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-ipc-"));
  const binary = join(directory, "gateway.mjs");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.op==='crash'){process.stdin.destroy();process.exit(1);}
  process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:{ready:true,echo:request.op}})+'\\n');
  if(request.op==='shutdown')process.exit(0);
});
`,
    { mode: 0o700 },
  );
  const gateway = new Gateway(binary);
  try {
    await gateway.start();
    assert.equal(gateway.ready, true);
    const [a, b] = await Promise.all([
      gateway.request("one"),
      gateway.request("two"),
    ]);
    assert.equal(a.echo, "one");
    assert.equal(b.echo, "two");
    const crash = once(gateway, "crash");
    await assert.rejects(gateway.request("crash", {}, 1000));
    await crash;
    assert.equal(gateway.ready, false);
    await assert.rejects(gateway.request("after-crash"), /unavailable/);
    await gateway.start();
    assert.equal((await gateway.request("restored")).echo, "restored");
  } finally {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
