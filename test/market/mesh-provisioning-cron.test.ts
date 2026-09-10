import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("actual provision script is idempotent and preserves Bitcoin archive ownership", () => {
  const workflow=readFileSync(".github/workflows/inmotion.yml","utf8");
  const start=workflow.indexOf('          mesh_bitcoin_owner=');
  const end=workflow.indexOf('          crontab "$cron_after"',start);
  assert.ok(start>0 && end>start);
  const body=workflow.slice(start,end).replace(/^          /gm,"");
  const script=`set -eu
    cron_before=$(mktemp); cron_after=$(mktemp)
    trap 'rm -f "$cron_before" "$cron_after"' EXIT
    cat > "$cron_before"
    app_dir=/fixture; flock_bin=/usr/bin/flock; lock_file=/fixture/shared/market-mesh.lock
    node_bin=/usr/bin/node; env_file=/fixture/shared/runtime.env; artifact=/fixture/current/scripts/mesh-tick-standalone.mjs
    log_file=/fixture/logs/market-mesh.log; logs_dir=/fixture/logs
    ${body}
    cat "$cron_after"`;
  const shell=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"bash";
  let input="0 * * * * echo unrelated\n* * * * * AKASHA_HOSE_OWNS_BITCOIN=1 node /fixture/current/scripts/mesh-tick-standalone.mjs >> /fixture/logs/market-mesh.log\n";
  for(let pass=0;pass<2;pass++){
    const result=spawnSync(shell,["--noprofile","--norc","-c",script],{input,encoding:"utf8",timeout:10000});
    assert.equal(result.status,0,result.stderr);input=result.stdout;
    for(const worker of ["mesh-tick-standalone.mjs","opensea-stream-standalone.mjs","market-realtime.mjs"])
      assert.equal(input.split("\n").filter(line=>line.includes(worker)).length,1,`${worker} has exactly one cron command`);
    assert.match(input,/AKASHA_HOSE_OWNS_BITCOIN=1/);assert.match(input,/echo unrelated/);
  }
});
