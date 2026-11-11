'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'directory-inventory-')),file=path.join(dir,'host.json');
try {
 const run=()=>spawnSync('python3',[path.join(__dirname,'../scripts/register-directory.py'),file],{encoding:'utf8'});
 fs.writeFileSync(file,JSON.stringify({services:{existing:{port:5000}}}));assert.equal(run().status,0);let d=JSON.parse(fs.readFileSync(file));assert.equal(d.services.existing.port,5000);assert.equal(d.services.directory.port,5281);assert.equal(d.services.directory.databases[0].database,'ov_directory');assert.deepEqual(require('../lib/lifecycle').check(d.services.directory.lifecycle,{runs:true}),[]);assert.equal(run().status,0);
 const legacy=spawnSync('python3',['-c',`import runpy,json;print(json.dumps(runpy.run_path('${path.join(__dirname,'../scripts/register-directory.py')}')['old_entry']()))`],{encoding:'utf8'});
 fs.writeFileSync(file,JSON.stringify({services:{directory:JSON.parse(legacy.stdout)}}));assert.equal(run().status,0);d=JSON.parse(fs.readFileSync(file));assert.equal(d.services.directory.databases[0].database,'ov_directory');
 fs.writeFileSync(file,JSON.stringify({services:{collision:{port:5281}}}));assert.notEqual(run().status,0);assert(!JSON.parse(fs.readFileSync(file)).services.directory);
 console.log('directory registration: preserves inventory, idempotent, rejects port collision');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
