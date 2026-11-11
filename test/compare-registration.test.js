'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compare-inventory-')),file=path.join(dir,'host.json');
try {
 const run=()=>spawnSync('python3',[path.join(__dirname,'../scripts/register-compare.py'),file],{encoding:'utf8'});
 fs.writeFileSync(file,JSON.stringify({services:{existing:{port:5000}}}));assert.equal(run().status,0);let d=JSON.parse(fs.readFileSync(file));assert.equal(d.services.existing.port,5000);assert.equal(d.services.compare.port,5280);assert.deepEqual(d.services.compare.databases,[]);assert.equal(run().status,0);
 fs.writeFileSync(file,JSON.stringify({services:{collision:{port:5280}}}));assert.notEqual(run().status,0);assert(!JSON.parse(fs.readFileSync(file)).services.compare);
 console.log('compare registration: preserves inventory, idempotent, rejects port collision');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
