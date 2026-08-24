/* ============================================================
   Server role-projection tests  —  api/state.js
   ------------------------------------------------------------
   These prove the part of the permission story the browser cannot:
   that the SERVER declines to send data a person's job does not
   cover, and refuses to let them write back what it never sent.

   They run the REAL functions out of api/state.js — the file is
   fetched, the projection block is sliced out between its markers
   and evaluated, so the tests cannot drift from the shipped code.

   To run, with the folder served over http (port 8021 here):
     open  ALP Sales Tracker.html  and in the console:
       await ALP_loadProjection(); ALP_runProjectionTests()
   or paste this whole file into the console first.
   ============================================================ */
(function(){
  var SRV=null;

  async function ALP_loadProjection(base){
    var url=(base||'')+'/api/state.js?x='+Math.random();
    var src=await (await fetch(url)).text();
    var a=src.indexOf('// ===== ROLE PROJECTION'), b=src.indexOf('\nconst DB_URL =');
    if(a<0||b<0) throw new Error('projection markers not found in api/state.js');
    SRV=new Function(src.slice(a,b)+'\n; return {projectState:projectState, mergeProtected:mergeProtected,'+
      ' whoCtx:whoCtx, ROLE_CAPS:ROLE_CAPS, COMP_FIELDS:COMP_FIELDS, WRITE_PROTECTED:WRITE_PROTECTED};')();
    return SRV;
  }

  // ---- fixture: one small company ----
  function P(id,email,x){
    return Object.assign({id:id,name:id,email:email,active:true,start:'2026-01-01',mgr:'',roles:['sales'],
      title:'',caps:[],admin:false,rate:20,commNew:10,commUp:5,commRenew:5,commOv:0,pin:'',hours:{},
      std:1,win:1,val:0,hit:0,goal:0,floor:0,salesPct:100,acv:900,scored:true,note:''},x||{});
  }
  function R(id,rep,v,x){
    return Object.assign({id:id,rep:rep,date:'2026-06-05',client:'C '+id,service:'S',value:v,basis:'contract',
      qty:1,type:'new',src:'SA',invoiced:'2026-06-10',paid:'',paidAmt:null,voidType:'',voidAmt:0},x||{});
  }
  function doc(){
    return {v:7,saved:'2026-08-23',
      people:[P('JEFF','jeff@automatedlawnandpest.com',{roles:['sales','manager'],admin:true,commNew:0}),
              P('MGR','mgr@automatedlawnandpest.com',{roles:['manager'],commOv:5,rate:30}),
              P('REP','rep@automatedlawnandpest.com',{mgr:'MGR',commNew:10,rate:22}),
              P('REP2','rep2@automatedlawnandpest.com',{mgr:'MGR2',commNew:12,rate:24}),
              P('BIL','bil@automatedlawnandpest.com',{roles:['office'],title:'Billing Coordinator',rate:26}),
              P('TECH','tech@automatedlawnandpest.com',{roles:['tech'],rate:28})],
      rows:[R('r1','REP',1000), R('r2','REP2',2000), R('r3','MGR',3000), R('r4','JEFF',4000),
            R('r5','REP2',5000,{split:[{rep:'REP',pct:50},{rep:'REP2',pct:50}]})],
      payouts:[{id:'p1',emp:'REP',kind:'rep',amount:100,rowId:'r1'},
               {id:'p2',emp:'REP2',kind:'rep',amount:200,rowId:'r2'},
               {id:'p3',emp:'MGR',kind:'override',amount:50,rowId:'r1'}],
      disputes:[{id:'d1',rep:'REP',amount:10},{id:'d2',rep:'REP2',amount:20}],
      hours:[{id:'h1',rep:'REP',date:'2026-06-01',hours:40},{id:'h2',rep:'REP2',date:'2026-06-01',hours:50}],
      clients:[{id:'c1',name:'Acme'}],
      invoices:[{id:'i1',client:'Acme',total:900}],
      payments:[{id:'y1',inv:'i1',amt:900}],
      openinv:[{id:'o1',client:'Acme',t:400}],
      paidinv:[{i:'12328',c:'Acme',p:'2026-08-14',v:523.68,r:'Rep Person'}],
      invlinks:[{id:'l1',no:'12328',rowId:'r1',by:'jeff',on:'2026-08-24'}],
      invclimap:[{id:'m1',key:'acme',u:'U1',name:'Acme',by:'jeff',on:'2026-08-24'}],
      invsyncs:[{id:'s1'}], paysyncs:[{id:'s2'}], balsyncs:[{id:'s3'}], pdisyncs:[{id:'s4'}],
      tombstones:[], oscs:[], global:{payLag:30,policy:{clawbackDays:180}}};
  }
  var EM={jeff:'jeff@automatedlawnandpest.com', mgr:'mgr@automatedlawnandpest.com',
          rep:'rep@automatedlawnandpest.com', rep2:'rep2@automatedlawnandpest.com',
          bil:'bil@automatedlawnandpest.com', tech:'tech@automatedlawnandpest.com',
          ghost:'nobody@automatedlawnandpest.com'};

  function ALP_runProjectionTests(){
    if(!SRV) throw new Error('call await ALP_loadProjection() first');
    var results=[];
    function check(name,expected,actual){
      var bothNum=typeof expected==='number'&&typeof actual==='number';
      results.push({name:name,expected:expected,actual:actual,
        pass: bothNum? expected===actual : String(expected)===String(actual)});
    }
    function ok(name,cond,actual){ results.push({name:name,expected:true,actual:actual===undefined?cond:actual,pass:!!cond}); }
    var stored=JSON.stringify(doc());
    var see=function(email){ return JSON.parse(SRV.projectState(stored,email)); };
    var ids=function(list){ return (list||[]).map(function(x){return x.id;}).sort().join(','); };
    var find=function(d,id){ return (d.people||[]).find(function(p){return p.id===id;}); };

    /* ---------- READ: what the server hands over ---------- */
    var asRep=see(EM.rep);
    check('READ rep gets only their own sales (own + their half of a split)','r1,r5',ids(asRep.rows));
    ok('READ a colleague pay rate is ABSENT, not zero', find(asRep,'REP2').commNew===undefined && find(asRep,'REP2').rate===undefined,
       JSON.stringify({commNew:find(asRep,'REP2').commNew,rate:find(asRep,'REP2').rate}));
    ok('READ the colleague record is marked withheld', find(asRep,'REP2').compHidden===true, find(asRep,'REP2').compHidden);
    check('READ their own pay rate still arrives',10,find(asRep,'REP').commNew);
    check('READ ledger is their own only','p1',ids(asRep.payouts));
    check('READ disputes are their own only','d1',ids(asRep.disputes));
    check('READ hours are their own only','h1',ids(asRep.hours));
    check('READ company billing is withheld from a rep','0/0/0/0/0/0',
      [asRep.invoices.length,asRep.payments.length,asRep.openinv.length,asRep.paidinv.length,
       asRep.invlinks.length,asRep.invclimap.length].join('/'));
    ok('READ the client roster still arrives (they need it to work)', asRep.clients.length===1, asRep.clients.length);
    ok('READ no manager override entry leaks to the rep it was earned on',
      !asRep.payouts.some(function(x){return x.kind==='override';}), ids(asRep.payouts));

    var asMgr=see(EM.mgr);
    check('READ manager gets their own and their team’s sales','r1,r3,r5',ids(asMgr.rows));
    check('READ manager does NOT get another manager’s report',undefined,
      (asMgr.rows.find(function(r){return r.id==='r2';})||{}).id);
    check('READ manager sees a report’s pay',10,find(asMgr,'REP').commNew);
    ok('READ manager does NOT see an unrelated person’s pay', find(asMgr,'REP2').commNew===undefined, find(asMgr,'REP2').commNew);
    ok('READ manager does NOT see the owner’s pay', find(asMgr,'JEFF').commNew===undefined, find(asMgr,'JEFF').commNew);
    check('READ manager ledger covers the team','p1,p3',ids(asMgr.payouts));
    ok('READ manager gets billing (they carry revenue)', asMgr.invoices.length===1, asMgr.invoices.length);

    var asBil=see(EM.bil);
    check('READ billing gets no sales rows at all','',ids(asBil.rows));
    ok('READ billing gets invoices, payments, open balances and paid invoices',
      asBil.invoices.length===1&&asBil.payments.length===1&&asBil.openinv.length===1&&asBil.paidinv.length===1,
      [asBil.invoices.length,asBil.payments.length,asBil.openinv.length,asBil.paidinv.length].join('/'));
    ok('READ billing gets nobody’s pay rate', find(asBil,'REP').commNew===undefined&&find(asBil,'MGR').rate===undefined, 'ok');
    check('READ billing gets no payout ledger','',ids(asBil.payouts));

    var asTech=see(EM.tech);
    check('READ a field tech gets no sales','',ids(asTech.rows));
    check('READ a field tech gets no ledger, hours or billing','0/0/0',
      [asTech.payouts.length,asTech.hours.length,asTech.invoices.length].join('/'));
    ok('READ a field tech keeps their own record', find(asTech,'TECH').rate===28, find(asTech,'TECH').rate);

    var asGhost=see(EM.ghost);
    check('READ an email nobody on the roster owns gets no sales','',ids(asGhost.rows));
    check('READ an unknown email gets no ledger and no billing','0/0',
      [asGhost.payouts.length,asGhost.invoices.length].join('/'));
    ok('READ an unknown email gets nobody’s pay', (asGhost.people||[]).every(function(p){return p.commNew===undefined;}), 'ok');

    /* ---------- WRITE: what the server refuses to take back ---------- */
    // A rep's honest save: exactly what they were sent, unchanged.
    var back=function(mutate,email){
      var mine=see(email||EM.rep);
      if(mutate) mutate(mine);
      var out=SRV.mergeProtected(JSON.stringify(mine), stored, email||EM.rep);
      return out?JSON.parse(out):null;
    };
    var S=JSON.parse(stored);

    var clean=back(null);
    ok('WRITE an honest round trip loses nothing — people', ids(clean.people)===ids(S.people), ids(clean.people));
    ok('WRITE an honest round trip loses nothing — sales', ids(clean.rows)===ids(S.rows), ids(clean.rows));
    ok('WRITE an honest round trip loses nothing — ledger', ids(clean.payouts)===ids(S.payouts), ids(clean.payouts));
    ok('WRITE an honest round trip loses nothing — hours, disputes, invoices',
      ids(clean.hours)===ids(S.hours)&&ids(clean.disputes)===ids(S.disputes)&&ids(clean.invoices)===ids(S.invoices), 'ok');
    ok('WRITE an honest round trip changes no value anywhere',
      JSON.stringify(clean.rows.slice().sort(function(a,b){return a.id<b.id?-1:1;}))===
      JSON.stringify(S.rows.slice().sort(function(a,b){return a.id<b.id?-1:1;})), 'ok');

    check('WRITE a rep cannot raise their OWN commission rate',10,
      find(back(function(d){ find(d,'REP').commNew=50; }),'REP').commNew);
    check('WRITE a rep cannot raise their own hourly rate',22,
      find(back(function(d){ find(d,'REP').rate=99; }),'REP').rate);
    check('WRITE a rep cannot hand themselves a capability','',
      (find(back(function(d){ find(d,'REP').caps=['view_all_commissions']; }),'REP').caps||[]).join(','));
    check('WRITE a rep cannot hand themselves the admin flag',false,
      !!find(back(function(d){ find(d,'REP').admin=true; }),'REP').admin);
    check('WRITE a rep cannot change a colleague’s commission rate',12,
      find(back(function(d){ find(d,'REP2').commNew=0; }),'REP2').commNew);
    check('WRITE a rep cannot delete a colleague',6,
      back(function(d){ d.people=d.people.filter(function(p){return p.id!=='REP2';}); }).people.length);
    check('WRITE a rep cannot promote a colleague to admin',false,
      !!find(back(function(d){ find(d,'REP2').admin=true; }),'REP2').admin);

    var inj=back(function(d){ d.rows.push(R('r2','REP2',999999)); });
    check('WRITE a rep cannot rewrite a sale they were never sent',2000,
      inj.rows.find(function(r){return r.id==='r2';}).value);
    check('WRITE injecting it does not duplicate the sale',5,inj.rows.length);
    check('WRITE wiping their local sales takes only the ones that are wholly theirs','r2,r3,r4,r5',
      ids(back(function(d){ d.rows=[]; }).rows));
    check('WRITE a rep cannot delete a shared sale — it carries a colleague’s commission','r1,r2,r3,r4,r5',
      ids(back(function(d){ d.rows=d.rows.filter(function(r){return r.id!=='r5';}); }).rows));
    check('WRITE a rep CAN edit their own sale',1750,
      back(function(d){ d.rows.find(function(r){return r.id==='r1';}).value=1750; })
        .rows.find(function(r){return r.id==='r1';}).value);
    check('WRITE a rep CAN delete their own sale','r2,r3,r4,r5',
      ids(back(function(d){ d.rows=d.rows.filter(function(r){return r.id!=='r1';}); }).rows));
    check('WRITE a rep CAN log a new sale','r1,r2,r3,r4,r5,r9',
      ids(back(function(d){ d.rows.push(R('r9','REP',700)); }).rows));

    var pay=back(function(d){ d.payouts.push({id:'p9',emp:'REP2',kind:'rep',amount:99999,rowId:'r2'}); });
    check('WRITE a rep cannot invent a payout for someone else','p1,p2,p3',ids(pay.payouts));
    check('WRITE a colleague’s payout history survives the round trip',200,
      pay.payouts.find(function(x){return x.id==='p2';}).amount);
    check('WRITE a rep cannot invent a payout for THEMSELVES either','p1,p2,p3',
      ids(back(function(d){ d.payouts.push({id:'p8',emp:'REP',kind:'rep',amount:99999,rowId:'r1'}); }).payouts));
    check('WRITE a rep cannot rewrite their own paid ledger entry',100,
      back(function(d){ d.payouts.find(function(x){return x.id==='p1';}).amount=5000; })
        .payouts.find(function(x){return x.id==='p1';}).amount);
    check('WRITE a rep cannot wipe the ledger','p1,p2,p3',ids(back(function(d){ d.payouts=[]; }).payouts));
    check('WRITE a manager cannot write the ledger either','p1,p2,p3',
      ids(back(function(d){ d.payouts=[]; }, EM.mgr).payouts));
    check('WRITE a rep CAN raise a dispute of their own','d1,d2,d9',
      ids(back(function(d){ d.disputes.push({id:'d9',rep:'REP',amount:75}); }).disputes));
    check('WRITE a rep cannot raise a dispute in a colleague’s name','d1,d2',
      ids(back(function(d){ d.disputes.push({id:'d8',rep:'REP2',amount:75}); }).disputes));
    check('WRITE a rep cannot wipe company billing','i1',ids(back(function(d){ d.invoices=[]; }).invoices));
    check('WRITE a rep cannot wipe the paid-invoices feed',1,
      back(function(d){ d.paidinv=[]; }).paidinv.length);
    check('WRITE a rep cannot forge an invoice-sale link','l1',
      ids(back(function(d){ d.invlinks=[{id:'l9',no:'99999',rowId:'r1'}]; }).invlinks));
    check('WRITE a rep cannot rewrite the client mappings','m1',
      ids(back(function(d){ d.invclimap=[]; }).invclimap));
    check('WRITE billing cannot wipe the invoice-sale links either','l1',
      ids(back(function(d){ d.invlinks=[]; }, EM.bil).invlinks));
    check('WRITE billing cannot forge a client mapping','m1',
      ids(back(function(d){ d.invclimap=[{id:'m9',key:'evil',u:'U9',name:'Evil'}]; }, EM.bil).invclimap));
    check('WRITE a manager CAN make an invoice-sale link','l1,l9',
      ids(back(function(d){ d.invlinks.push({id:'l9',no:'777',rowId:'r1'}); }, EM.mgr).invlinks));
    check('WRITE a rep cannot invent an invoice','i1',
      ids(back(function(d){ d.invoices.push({id:'i9',client:'Acme',total:-900}); }).invoices));
    /* ---- id-less collections must not multiply on every save ---- */
    // Invoice lines, payments, open balances and the sync logs carry no id: an invoice
    // line is identified by its content. Pairing them by id matched nothing and appended
    // the incoming copy beside the stored one, so every save by a manager or billing user
    // DOUBLED the whole invoice audit.
    var idless=function(email,rounds){
      var cur=stored;
      for(var i=0;i<rounds;i++){
        var sent=SRV.projectState(cur,email);
        cur=SRV.mergeProtected(sent,cur,email);
      }
      var d=JSON.parse(cur);
      return {inv:(d.invoices||[]).length, pay:(d.payments||[]).length,
              open:(d.openinv||[]).length, syn:(d.invsyncs||[]).length, pdi:(d.paidinv||[]).length,
              total:(d.invoices||[]).reduce(function(a,x){return a+(+x.total||+x.v||0);},0)};
    };
    check('IDLESS billing saving three times does not multiply the invoice audit','1/1/1/1/1',
      (function(){ var r=idless(EM.bil,3); return [r.inv,r.pay,r.open,r.syn,r.pdi].join('/'); })());
    check('IDLESS a manager saving three times does not multiply it either','1/1/1/1/1',
      (function(){ var r=idless(EM.mgr,3); return [r.inv,r.pay,r.open,r.syn,r.pdi].join('/'); })());
    check('IDLESS a rep saving three times leaves it exactly as stored','1/1/1/1/1',
      (function(){ var r=idless(EM.rep,3); return [r.inv,r.pay,r.open,r.syn,r.pdi].join('/'); })());
    check('IDLESS the billed total is unchanged after three saves',900,idless(EM.bil,3).total);

    check('WRITE billing CAN add an invoice','i1,i9',
      ids(back(function(d){ d.invoices.push({id:'i9',client:'Acme',total:120}); }, EM.bil).invoices));
    check('WRITE a rep cannot change a colleague’s hours',50,
      back(function(d){ d.hours=[{id:'h2',rep:'REP2',date:'2026-06-01',hours:0}]; })
        .hours.find(function(x){return x.id==='h2';}).hours);

    var np=back(function(d){ d.people.push(P('NEW','new@automatedlawnandpest.com',{commNew:99,rate:99,admin:true,caps:['admin_security']})); });
    var madeUp=find(np,'NEW');
    ok('WRITE a person a rep invents arrives with no pay, no caps and no admin',
      madeUp && madeUp.commNew===undefined && madeUp.rate===undefined && madeUp.caps===undefined && madeUp.admin===undefined,
      JSON.stringify({commNew:madeUp&&madeUp.commNew,admin:madeUp&&madeUp.admin,caps:madeUp&&madeUp.caps}));
    ok('WRITE a person a rep invents carries no role, no manager and no email',
      madeUp && madeUp.roles===undefined && madeUp.mgr===undefined && madeUp.email===undefined,
      JSON.stringify({roles:madeUp&&madeUp.roles,mgr:madeUp&&madeUp.mgr,email:madeUp&&madeUp.email}));
    check('WRITE a rep cannot become somebody else by adding a record with the owner’s address','JEFF',
      (function(){ var m=back(function(d){ d.people.push(P('FAKE','jeff@automatedlawnandpest.com',{})); });
                   return SRV.whoCtx(m,'jeff@automatedlawnandpest.com').me; })());

    // Escalation by editing the roster itself
    check('WRITE a rep cannot promote themselves to manager on the roster and take the team’s data',
      'r1,r5', ids((function(){ var m=back(function(d){ find(d,'REP').roles=['manager']; find(d,'REP2').mgr='REP'; });
                     return JSON.parse(SRV.projectState(JSON.stringify(m),EM.rep)).rows; })()));
    check('WRITE their roles come back as stored','sales',
      (find(back(function(d){ find(d,'REP').roles=['manager','owner']; }),'REP').roles||[]).join(','));
    check('WRITE a job title of "owner" on the roster grants nothing',
      'r1,r5', ids((function(){ var m=back(function(d){ find(d,'REP').roles=['owner','sales']; });
                     return JSON.parse(SRV.projectState(JSON.stringify(m),EM.rep)).rows; })()));
    check('WRITE a rep cannot reassign who they report to','MGR',
      find(back(function(d){ find(d,'REP').mgr=''; }),'REP').mgr);
    check('WRITE a rep cannot take over a colleague’s email address','rep2@automatedlawnandpest.com',
      find(back(function(d){ find(d,'REP2').email='x@automatedlawnandpest.com'; }),'REP2').email);
    check('WRITE a rep cannot bolt the owner’s address onto their own record',undefined,
      find(back(function(d){ find(d,'REP').altEmails=['jeff@automatedlawnandpest.com']; }),'REP').altEmails);
    check('WRITE a rep cannot retitle themselves into the billing bundle','',
      find(back(function(d){ find(d,'REP').title='Billing Coordinator'; }),'REP').title);
    check('WRITE a rep cannot deactivate a colleague',true,
      find(back(function(d){ find(d,'REP2').active=false; }),'REP2').active);
    check('WRITE a rep CAN still save their own photo','data:image/jpeg;base64,AAA',
      find(back(function(d){ find(d,'REP').photo='data:image/jpeg;base64,AAA'; }),'REP').photo);
    check('WRITE a rep cannot put a photo on somebody else’s record',undefined,
      find(back(function(d){ find(d,'REP2').photo='data:image/jpeg;base64,BBB'; }),'REP2').photo);

    // The manager's own save is scoped the same way
    check('WRITE a manager cannot rewrite a sale outside their team',2000,
      back(function(d){ d.rows.push(R('r2','REP2',1)); }, EM.mgr).rows.find(function(r){return r.id==='r2';}).value);
    check('WRITE a manager cannot change a report’s pay rate',10,
      find(back(function(d){ find(d,'REP').commNew=40; }, EM.mgr),'REP').commNew);

    // Client/server bundles must not drift
    ok('The server’s role bundles match the app’s',
      (typeof ROLE_CAPS==='undefined')||['manager','sales','estimator','csr','office','billing','tech','field']
        .every(function(k){ return JSON.stringify((ROLE_CAPS[k]||[]).slice().sort())===JSON.stringify((SRV.ROLE_CAPS[k]||[]).slice().sort()); }),
      typeof ROLE_CAPS==='undefined'?'app not loaded — skipped':'compared');
    ok('The server never grants an owner bundle from a job title', SRV.ROLE_CAPS.owner===undefined, SRV.ROLE_CAPS.owner);

    var pass=results.filter(function(r){return r.pass;}).length;
    var out={pass:pass,fail:results.length-pass,total:results.length,results:results};
    try{
      console.log('%cServer projection: '+pass+'/'+results.length+' passed',
        'font-weight:700;color:'+(out.fail?'#c00':'#0a0'));
      console.table(results.map(function(r){return {test:r.name,expected:r.expected,actual:r.actual,pass:r.pass};}));
    }catch(e){}
    return out;
  }

  window.ALP_loadProjection=ALP_loadProjection;
  window.ALP_runProjectionTests=ALP_runProjectionTests;
})();
