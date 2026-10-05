import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJobStore} from './job-store.mjs';
import {resolveTemplateSelection} from '../../src/templates/catalog.mjs';
const canonical={templateId:'classic',templateVersion:'1',variationId:'default'};
const alternate={templateId:'test-only',templateVersion:'1',variationId:'default'};
const resolveSelection=(s)=>s?.templateId==='test-only'?{selection:alternate,treatment:{id:'test-only',version:'1'},compositionId:'Test',renderKey:'test-only@1'}:resolveTemplateSelection(s);
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'classic-jobs-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'jobs.sqlite');}
test('migrates legacy active and terminal jobs without changing their results',async(t)=>{
 const file=await setup(t);const db=new DatabaseSync(file);
 db.exec("CREATE TABLE jobs (job_id TEXT PRIMARY KEY,video_id TEXT NOT NULL,source_url TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,result_json TEXT,error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
 for(const state of ['queued','running','complete','failed'])db.prepare('INSERT INTO jobs(job_id,video_id,source_url,status,result_json) VALUES(?,?,?,?,?)').run(state,state,'https://youtu.be/abcdefghijk',state,state==='complete'?JSON.stringify({status:'complete',artifacts:['out/old.mp4']}):null);
 db.close();
 for(let i=0;i<2;i++) {
  const store=createJobStore(file);
  try {for(const state of ['queued','running','complete','failed']){const job=store.getJob(state);assert.equal(job.status,state);assert.deepEqual(job.selection,canonical);assert.equal(job.renderKey,'audiogram-basic@1');}assert.deepEqual(store.getJob('complete').result.artifacts,['out/old.mp4']);}finally{store.close();}
 }
});
test('same active selection reuses job while different selection conflicts across connections',async(t)=>{
 const file=await setup(t);const one=createJobStore(file,{resolveSelection});const two=createJobStore(file,{resolveSelection});t.after(()=>{one.close();two.close();});
 const first=one.createOrGetJob({videoId:'v',sourceUrl:'https://youtu.be/abcdefghijk'});
 assert.equal(two.createOrGetJob({videoId:'v',sourceUrl:'https://youtu.be/abcdefghijk',selection:canonical}).job.jobId,first.job.jobId);
 assert.throws(()=>two.createOrGetJob({videoId:'v',sourceUrl:'https://youtu.be/abcdefghijk',selection:alternate}),{code:'VIDEO_BUSY_DIFFERENT_TEMPLATE'});
 one.setResult(first.job.jobId,{status:'complete',artifacts:[]});
 const next=two.createOrGetJob({videoId:'v',sourceUrl:'https://youtu.be/abcdefghijk',selection:alternate});
 assert.equal(next.created,true);assert.notEqual(next.job.jobId,first.job.jobId);assert.equal(next.job.renderKey,'test-only@1');
});
test('invalid selection creates no job and cannot poison a later valid request',async(t)=>{
 const file=await setup(t);const store=createJobStore(file);t.after(()=>store.close());
 assert.throws(()=>store.createOrGetJob({videoId:'v',sourceUrl:'url',selection:{variationId:'invalid'}}),{code:'INVALID_TEMPLATE_SELECTION'});
 assert.throws(()=>store.createOrGetJob({videoId:'v',sourceUrl:'url',selection:canonical,renderKey:'fake@1'}),/identity/i);
 assert.equal(store.createOrGetJob({videoId:'v',sourceUrl:'url'}).created,true);
});
