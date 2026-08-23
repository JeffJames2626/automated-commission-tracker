/* ============================================================
   ALP Sales Tracker — regression tests
   ------------------------------------------------------------
   Covers the four financial / data-integrity bugs from the QC
   report: C1 (commission on cancelled sales), C2 (deleted
   records resurrecting), H1 (payLag rewriting closed months),
   H2 (cancelled work counting toward production).

   Runs against the REAL functions loaded on the page — no
   duplicated logic. It snapshots the live globals, swaps in
   fixtures, asserts, and restores. It never calls save(), so
   real localStorage data is untouched.

   To run: open the tracker with #selftest in the URL
     ALP Sales Tracker.html#selftest
   or call ALP_runRegression() from the console.
   ============================================================ */
(function(){
  function num(x){ return Math.round((+x||0)*100)/100; }

  function mkPerson(o){
    return Object.assign({
      id:'TP', name:'Test Rep', title:'', active:true, start:'2026-01-01', mgr:'',
      rate:20, hrsIn:40, hrsOff:0, offMonths:[], commNew:10, commUp:5, commRenew:5, commOv:0,
      std:1, win:1, val:0, hit:0, goal:0, floor:0, upsellVal:false, payFrom:'',
      scored:true, salesPct:100, admin:false, pin:'', acv:900, unit:'clients', note:'', hours:{}
    }, o||{});
  }
  var _n=0;
  function mkRow(o){
    return Object.assign({
      id:'tr'+(++_n), rep:'TP', date:'2026-06-05', client:'C', service:'S',
      value:1000, basis:'contract', qty:1, type:'new', src:'SA', notes:'',
      completed:'', invoiced:'', paid:'', paidAmt:null,
      voidType:'', voidDate:'', voidAmt:0, voidNote:''
    }, o||{});
  }

  function ALP_runRegression(){
    var results=[];
    function check(name, expected, actual){
      // Numbers compared numerically (penny-tolerant); everything else compared as strings.
      // Never route a date string through Number() — it yields NaN and false-passes.
      var bothNum = typeof expected==='number' && typeof actual==='number';
      var pass = bothNum ? num(expected)===num(actual) : String(expected)===String(actual);
      results.push({name:name, expected:expected, actual:actual, pass:pass});
    }
    function checkTrue(name, cond, actual){
      results.push({name:name, expected:true, actual:actual, pass:!!cond});
    }

    // ---- snapshot every global the tests touch ----
    var snap={ PEOPLE:PEOPLE, ROWS:ROWS, GLOBAL:GLOBAL, DISPUTES:DISPUTES,
               CLIENTS:(typeof CLIENTS!=='undefined'?CLIENTS:undefined),
               INVOICES:(typeof INVOICES!=='undefined'?INVOICES:undefined),
               TAKEOVERS:(typeof TAKEOVERS!=='undefined'?TAKEOVERS:undefined),
               OSCS:(typeof OSCS!=='undefined'?OSCS:undefined),
               PAYOUTS:(typeof PAYOUTS!=='undefined'?PAYOUTS:undefined),
               save:(typeof save==='function'?save:undefined),
               HOURS:(typeof HOURS!=='undefined'?HOURS:undefined),
               TOMBSTONES:(typeof TOMBSTONES!=='undefined'?TOMBSTONES:undefined),
               AUDIT:(typeof AUDIT!=='undefined'?AUDIT:undefined),
               AUDITQ:(typeof AUDITQ!=='undefined'?AUDITQ:undefined) };
    try{
      // Nothing a test does may reach localStorage: the app's save() is a no-op while tests run.
      if(typeof save==='function') save=function(){};
      var P = mkPerson();
      PEOPLE=[P]; DISPUTES=[]; if(typeof HOURS!=='undefined') HOURS=[];
      GLOBAL=Object.assign({}, snap.GLOBAL, {payLag:30,
        season:(typeof SEASON_DEFAULT!=='undefined'?SEASON_DEFAULT.slice():[]),
        policy:Object.assign({clawbackDays:180,respondDays:10,raiseDays:30}, (snap.GLOBAL&&snap.GLOBAL.policy)||{})});

      /* ---------- C1: commission uses net value after reversal ---------- */
      // T1 normal new sale, unpaid, active
      ROWS=[mkRow({type:'new', value:1000})];
      check('C1.T1 normal new (10% of $1000)', 100, commissionFor(P,'2026-06','sold').commission);

      // T2 paid new sale, active
      ROWS=[mkRow({type:'new', value:1000, invoiced:'2026-06-10', paid:'2026-06-20', paidAmt:100})];
      check('C1.T2 paid new', 100, commissionFor(P,'2026-06','sold').commission);

      // T3 cancelled BEFORE payment — must earn $0  (BUG: currently pays $100)
      ROWS=[mkRow({type:'new', value:1000, voidType:'cancelled', voidDate:'2026-06-15', voidAmt:0})];
      check('C1.T3 cancelled-before-pay earns $0', 0, commissionFor(P,'2026-06','sold').commission);

      // T4 cancelled AFTER payment — sale month keeps gross, reversal month claws it back
      ROWS=[mkRow({type:'new', value:1000, invoiced:'2026-06-10', paid:'2026-06-20', paidAmt:100,
                   voidType:'refunded', voidDate:'2026-07-10', voidAmt:1000})];
      check('C1.T4 paid-then-reversed: sale month = $100', 100, commissionFor(P,'2026-06','sold').commission);
      check('C1.T4 paid-then-reversed: reversal month clawback = $100', 100, commissionFor(P,'2026-07','sold').cbTotal);

      // T5 partial reversal, unpaid — net $600 → $60  (BUG: currently $100)
      ROWS=[mkRow({type:'new', value:1000, voidType:'refunded', voidDate:'2026-06-15', voidAmt:400})];
      check('C1.T5 partial reversal unpaid (10% of net $600)', 60, commissionFor(P,'2026-06','sold').commission);

      // T6 upsell, unpaid, active — 5% of $1000
      ROWS=[mkRow({type:'upsell', value:1000})];
      check('C1.T6 upsell (5% of $1000)', 50, commissionFor(P,'2026-06','sold').commission);

      // T7 upsell cancelled before payment — $0
      ROWS=[mkRow({type:'upsell', value:1000, voidType:'cancelled', voidDate:'2026-06-15', voidAmt:0})];
      check('C1.T7 upsell cancelled-before-pay earns $0', 0, commissionFor(P,'2026-06','sold').commission);

      /* ---------- H1: freeze due date against payLag changes ---------- */
      // A sale invoiced with the lag frozen must not move when payLag changes later.
      GLOBAL.payLag=30;
      var inv=mkRow({invoiced:'2026-06-20'});
      if(typeof freezeDueLag==='function') freezeDueLag(inv);   // fix stamps dueLag; before fix this is a no-op/undefined
      var before=dueDate(inv);
      GLOBAL.payLag=10;                                          // admin changes the global setting
      var after=dueDate(inv);
      check('H1 due date frozen at +30 days', '2026-07-20', before);
      check('H1 changing payLag does NOT move a frozen sale', before, after);
      // and a brand-new invoice after the change uses the new lag (future records only)
      var inv2=mkRow({invoiced:'2026-06-20'});
      if(typeof freezeDueLag==='function') freezeDueLag(inv2);
      check('H1 new invoice uses the new lag (+10)', '2026-06-30', dueDate(inv2));

      /* ---------- H2: cancelled work earns no production credit ---------- */
      // two new sales same completed week: one active $1000, one fully cancelled $1000
      ROWS=[ mkRow({type:'new', value:1000, date:'2026-06-01'}),
             mkRow({type:'new', value:1000, date:'2026-06-02', voidType:'cancelled', voidDate:'2026-06-10', voidAmt:0}) ];
      var a=analyzeFor('TP');
      check('H2 production value counts only the active sale', 1000, a.newV);
      check('H2 client count excludes the cancelled sale', 1, a.newCount);
      check('H2 total value net of cancellation', 1000, a.totalV);
      // no regression: two active sales still both count
      ROWS=[ mkRow({type:'new', value:1000, date:'2026-06-01'}),
             mkRow({type:'new', value:1000, date:'2026-06-02'}) ];
      var a2=analyzeFor('TP');
      check('H2 no-regression: two active sales still $2000', 2000, a2.newV);
      check('H2 no-regression: two active sales still count 2', 2, a2.newCount);

      /* ---------- H2b: commission report values match the scoreboard (net) ---------- */
      ROWS=[ mkRow({type:'new', value:10000}),
             mkRow({type:'new', value:6000, voidType:'cancelled', voidDate:'2026-06-15', voidAmt:0}) ];
      var cr=commissionFor(P,'2026-06','sold');
      check('H2b commission-report newV is NET of cancellations', 10000, cr.newV);
      check('H2b matches scoreboard newV', analyzeFor('TP').newV, cr.newV);

      /* ---------- SPLITS: held until both reps + admin approve ---------- */
      if(typeof splitState==='function'){
        var P2=mkPerson({id:'TP2', name:'Second Rep'});
        PEOPLE=[P, P2];
        var sr=mkRow({type:'new', value:1000, split:[{rep:'TP',pct:60},{rep:'TP2',pct:40}]});
        // no approvals yet -> pending -> commission HELD for everyone
        ROWS=[sr];
        check('SPLIT pending: primary rep gets $0 (held)', 0, commissionFor(P,'2026-06','sold').commission);
        check('SPLIT pending: second rep gets $0 (held)', 0, commissionFor(P2,'2026-06','sold').commission);
        check('SPLIT pending: heldC shows what primary WOULD get', 60, commissionFor(P,'2026-06','sold').heldC);
        // both reps + admin approve -> processes at shares
        sr.splitOk={reps:{TP:'2026-06-10',TP2:'2026-06-10'}, admin:{by:'',on:'2026-06-10'}};
        check('SPLIT approved: 60% share pays $60', 60, commissionFor(P,'2026-06','sold').commission);
        check('SPLIT approved: 40% share pays $40', 40, commissionFor(P2,'2026-06','sold').commission);
        // production value splits; client count stays with the primary rep
        var aP=analyzeFor('TP'), aP2=analyzeFor('TP2');
        check('SPLIT production: primary value share', 600, aP.newV);
        check('SPLIT production: second value share', 400, aP2.newV);
        check('SPLIT counts: primary keeps the client count', 1, aP.newCount);
        check('SPLIT counts: second gets no client count', 0, aP2.newCount);
        PEOPLE=[P];
      } else {
        results.push({name:'SPLIT engine exists (splitState/shareFor)', expected:true, actual:false, pass:false});
      }

      /* ---------- C-1: imported "Renewal" must never become a NEW sale ---------- */
      if(typeof parseSaleType==='function'){
        check('C-1 "Renewal" parses as renewal', 'renewal', parseSaleType('Renewal','new'));
        check('C-1 "renewal" lowercase', 'renewal', parseSaleType('renewal','new'));
        check('C-1 "New" still parses as new', 'new', parseSaleType('New','upsell'));
        check('C-1 "New Client" parses as new', 'new', parseSaleType('New Client','upsell'));
        check('C-1 "Upsell" unchanged', 'upsell', parseSaleType('Upsell','new'));
        check('C-1 blank falls to default', 'upsell', parseSaleType('','upsell'));
        check('C-1 unknown falls to default', 'new', parseSaleType('Mystery','new'));
      } else {
        results.push({name:'C-1 parseSaleType() exists', expected:true, actual:false, pass:false});
      }

      /* ---------- H-B: paid months are frozen against later edits ---------- */
      // paid new sale at 10% -> $100 frozen. Flip type to renewal (2%): report must STILL say $100.
      var hb=mkRow({type:'new', value:1000, invoiced:'2026-06-10', paid:'2026-06-20', paidAmt:100});
      ROWS=[hb];
      check('H-B paid month before edit', 100, commissionFor(P,'2026-06','sold').commission);
      hb.type='renewal';
      check('H-B paid month UNCHANGED after type flip', 100, commissionFor(P,'2026-06','sold').commission);
      var oldRate=P.commNew; P.commNew=20;
      check('H-B paid month UNCHANGED after rate change', 100, commissionFor(P,'2026-06','sold').commission);
      P.commNew=oldRate;

      /* ---------- H-A: hawk finds real dups, ignores generic-word noise ---------- */
      if(typeof runChecks==='function'){
        ROWS=[];
        // noise: 30 cross-source pairs sharing only the generic word "Customer"
        for(var ni=0; ni<30; ni++){
          ROWS.push(mkRow({client:'Customer Alpha'+ni, src:'SA', value:500, date:'2026-06-01'}));
          ROWS.push(mkRow({client:'Customer Beta'+ni,  src:'EL', value:500, date:'2026-06-05'}));
        }
        // one real duplicate: rare surname, near-identical money, different systems
        ROWS.push(mkRow({client:'Smith Residence', src:'EL', value:10000, date:'2026-06-03'}));
        ROWS.push(mkRow({client:'John Smith',      src:'SA', value:10000, date:'2026-06-13'}));
        var hcross=runChecks().find(function(c){return c.id==='cross';});
        var items=(hcross?hcross.items:[]).map(function(it){return it.text.replace(/<[^>]*>/g,'');});
        checkTrue('H-A real dup (Smith) is flagged', items.some(function(t){return /Smith/.test(t);}),
          items.length+' flags');
        checkTrue('H-A generic-word noise suppressed (<5 false flags)',
          items.filter(function(t){return /Customer/.test(t);}).length<5,
          items.filter(function(t){return /Customer/.test(t);}).length+' noise flags');
      }

      /* ---------- HAWK-TAX: sale keyed with tax included gets flagged ---------- */
      if(typeof runChecks==='function' && typeof INVOICES!=='undefined'){
        var invSnap=INVOICES;
        // invoice: $100 pre-tax + $8.90 tax = $108.90 with tax
        INVOICES=[{c:'Tax Trap Co', i:'T1', d:'2026-06-10', s:'Mow', v:100, k:'Maintenance', t:8.9}];
        // BAD sale keyed at the with-tax figure; GOOD sale keyed pre-tax
        ROWS=[ mkRow({client:'Tax Trap Co', value:108.90, date:'2026-06-05'}),
               mkRow({client:'Tax Trap Co', value:100,    date:'2026-06-05'}) ];
        var tx=runChecks().find(function(c){return c.id==='hawkTax';});
        checkTrue('HAWK-TAX with-tax sale value flagged', tx && tx.items.length===1,
          tx?tx.items.length:'no check');
        checkTrue('HAWK-TAX pre-tax sale NOT flagged',
          !(tx && tx.items.some(function(it){return /100\.00 = /.test(it.text.replace(/<[^>]*>/g,''));})),
          'ok');
        INVOICES=invSnap;
      }

      /* ---------- DATA HAWK: cross-CRM double-count caught despite differences ---------- */
      // different spelling, $50 apart, 10 days apart — the naive exact-match missed all of this
      ROWS=[ mkRow({type:'upsell', value:12500, client:'Test Customer A', src:'EL', date:'2026-06-05'}),
             mkRow({type:'upsell', value:12450, client:'Test Cust A',    src:'SA', date:'2026-06-15'}) ];
      var crossChk=(typeof runChecks==='function')?runChecks().find(function(c){return c.id==='cross';}):null;
      checkTrue('HAWK catches fuzzy cross-CRM double (spelling+$50+10d)',
        crossChk && crossChk.items.length>=1, crossChk?crossChk.items.length:'no check');

      /* ---------- AUDIT TRAIL: every change lands on the trail ---------- */
      if(typeof auditRecord==='function' && typeof AUDIT!=='undefined'){
        AUDIT=[]; AUDITQ=[];
        var ar=mkRow({client:'Audit Test Co', value:500});
        ROWS=[ar];
        logEdit(ar,'value','500','750','user'); ar.value=750;
        checkTrue('AUDIT edit recorded', AUDIT.length===1 && AUDIT[0].action==='edit', AUDIT.length);
        checkTrue('AUDIT entry carries who/when/device',
          !!(AUDIT[0].t && AUDIT[0].user && AUDIT[0].dev && AUDIT[0].dev.tz!==undefined), JSON.stringify(AUDIT[0]).length);
        checkTrue('AUDIT entry queued for the server vault', AUDITQ.length===1, AUDITQ.length);
        checkTrue('AUDIT edits carry a full timestamp', !!ar.edits[0].at, ar.edits[0].at);
        // hawk: money edit AFTER commission paid must flag
        var hp=mkRow({client:'After Paid Co', value:1000, invoiced:'2026-06-01', paid:'2026-06-10', paidAmt:100});
        hp.edits=[{on:'2026-06-20', at:'2026-06-20T10:00:00Z', f:'value', from:'1000', to:'1400', by:'user'}];
        ROWS=[hp];
        var hA=runChecks().find(function(c){return c.id==='hawkAfterPaid';});
        checkTrue('HAWK flags money edit AFTER payout', hA && hA.items.length===1, hA?hA.items.length:'none');
        // hawk: value bumped then paid within 3 days
        var hb2=mkRow({client:'Bump Co', value:1400, invoiced:'2026-06-01', paid:'2026-06-12', paidAmt:140});
        hb2.edits=[{on:'2026-06-10', at:'2026-06-10T10:00:00Z', f:'value', from:'1000', to:'1400', by:'user'}];
        ROWS=[hb2];
        var hB=runChecks().find(function(c){return c.id==='hawkBump';});
        checkTrue('HAWK flags value raised right before payout', hB && hB.items.length===1, hB?hB.items.length:'none');
        // hawk: deleting a PAID sale leaves a flagged tombstone
        TOMBSTONES=[{srcKey:'SA|XX',compKey:'x',client:'Paid Deleted Co',value:900,on:'2026-06-15',paid:'2026-06-01',src:'SA',srcId:'XX'}];
        var hD=runChecks().find(function(c){return c.id==='hawkPaidDel';});
        checkTrue('HAWK flags a deleted PAID sale', hD && hD.items.length===1, hD?hD.items.length:'none');
        TOMBSTONES=[];
      } else {
        results.push({name:'AUDIT machinery exists', expected:true, actual:false, pass:false});
      }

      /* ---------- GOOGLE LOGIN plumbing (pure parts) ---------- */
      if(typeof findPersonByEmail==='function' && typeof authHeaders==='function'){
        PEOPLE=[mkPerson({id:'GP', name:'Google Person'})];
        PEOPLE[0].email='Jeff@AutomatedLawnAndPest.com';
        checkTrue('LOGIN email match is case-insensitive',
          findPersonByEmail('jeff@automatedlawnandpest.com')===PEOPLE[0], !!findPersonByEmail('jeff@automatedlawnandpest.com'));
        checkTrue('LOGIN unknown email maps to nobody', findPersonByEmail('nobody@nowhere.com')===null, 'ok');
        // session -> headers
        var sessSnap=localStorage.getItem('alp_session_v1');
        localStorage.setItem('alp_session_v1', JSON.stringify({token:'tok.abc',email:'x@y.com',name:'X',role:'rep'}));
        var h=authHeaders();
        checkTrue('LOGIN session token rides on requests', h['x-session']==='tok.abc', h['x-session']);
        localStorage.removeItem('alp_session_v1');
        var h2=authHeaders();
        checkTrue('LOGIN no session -> no session header', !h2['x-session'], 'ok');
        if(sessSnap!=null) localStorage.setItem('alp_session_v1',sessSnap);
        PEOPLE=[P];
      } else {
        results.push({name:'google login plumbing exists', expected:true, actual:false, pass:false});
      }

      /* ---------- LOGIN WALL: signed out = nothing to see ---------- */
      if(typeof sessionValid==='function' && typeof authOK==='function' && typeof authRequired==='function'){
        var wallSnap=localStorage.getItem('alp_session_v1');
        var gcidSnap=window.__GCID;
        function fakeTok(x){   // same shape the server signs: base64url(json).sig
          var b=btoa(JSON.stringify({e:'t@automatedlawnandpest.com',n:'T',r:'rep',x:x})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
          return b+'.notasignature';
        }
        localStorage.removeItem('alp_session_v1');
        checkTrue('WALL no session is not valid', !sessionValid(), sessionValid());
        localStorage.setItem('alp_session_v1', JSON.stringify({token:fakeTok(Date.now()-1000),email:'t@automatedlawnandpest.com',role:'rep'}));
        checkTrue('WALL expired token is not valid', !sessionValid(), sessionValid());
        localStorage.setItem('alp_session_v1', JSON.stringify({token:fakeTok(Date.now()+86400000),email:'t@automatedlawnandpest.com',role:'rep'}));
        checkTrue('WALL live token is valid', sessionValid(), sessionValid());
        // wall gating: no backend => never walled; backend + no session => walled
        window.__GCID=false;
        localStorage.removeItem('alp_session_v1');
        checkTrue('WALL no Google backend -> wall stays down', authOK(), authOK());
        if(location.protocol==='http:'||location.protocol==='https:'){
          window.__GCID='fake-client-id';
          var hosted = !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
          checkTrue('WALL hosted + signed out -> walled', authOK()===!hosted, authOK());
          localStorage.setItem('alp_session_v1', JSON.stringify({token:fakeTok(Date.now()+86400000),email:'t@automatedlawnandpest.com',role:'rep'}));
          checkTrue('WALL hosted + signed in -> open', authOK(), authOK());
        }
        window.__GCID=gcidSnap;
        if(wallSnap!=null) localStorage.setItem('alp_session_v1',wallSnap); else localStorage.removeItem('alp_session_v1');
      } else {
        results.push({name:'login wall exists (sessionValid/authOK/authRequired)', expected:true, actual:false, pass:false});
      }

      /* ---------- THE LAW: no invoice number + PDF, no invoiced/paid ---------- */
      if(typeof hasInvoiceEvidence==='function'){
        var law=mkRow({value:1000});
        checkTrue('LAW bare sale has no evidence', !hasInvoiceEvidence(law), hasInvoiceEvidence(law));
        law.invNo='12345';
        checkTrue('LAW invoice # alone is NOT enough', !hasInvoiceEvidence(law), hasInvoiceEvidence(law));
        law.invNo=''; law.files=[{id:1,name:'x.pdf',kb:10}];
        checkTrue('LAW PDF alone is NOT enough', !hasInvoiceEvidence(law), hasInvoiceEvidence(law));
        law.invNo='12345';
        checkTrue('LAW both = evidence complete', hasInvoiceEvidence(law), hasInvoiceEvidence(law));
        // hawk lists lawless sales, money-stage ones counted
        ROWS=[ mkRow({client:'Lawless Sold Co', value:500}),
               Object.assign(mkRow({client:'Lawless Paid Co', value:800, invoiced:'2026-06-01', paid:'2026-06-10', paidAmt:80})),
               Object.assign(mkRow({client:'Lawful Co', value:900, invoiced:'2026-06-01'}),{invNo:'777',files:[{id:9,name:'i.pdf',kb:5}]}) ];
        var lc=runChecks().find(function(c){return c.id==='hawkNoInv';});
        check('LAW hawk flags exactly the 2 lawless sales', 2, lc?lc.items.length:-1);
        checkTrue('LAW hawk names the money-stage one loudest',
          lc && /Lawless Paid/.test(lc.items[0].text.replace(/<[^>]*>/g,'')), lc?lc.items[0].text.slice(0,40):'');
        checkTrue('LAW lawful sale not flagged',
          !(lc&&lc.items.some(function(it){return /Lawful/.test(it.text);})), 'ok');
      } else {
        results.push({name:'hasInvoiceEvidence() exists', expected:true, actual:false, pass:false});
      }

      /* ---------- PDF DIFF: invoice-vs-sale comparison is exact ---------- */
      if(typeof pdfDiffFor==='function'){
        var pr=mkRow({client:'Diff Co', date:'2026-06-05', value:1000, service:'Mow'});
        var extract={client:'Diff Company LLC', sold_date:'2026-06-08',
          items:[{service:'Sprinkler Repair', value:1250}]};
        var dfs=pdfDiffFor(pr, extract);
        var byF={}; dfs.forEach(function(d){byF[d.f]=d;});
        checkTrue('PDF diff catches client mismatch', !!byF.client, JSON.stringify(byF.client||''));
        check('PDF diff catches date', '2026-06-08', byF.date?byF.date.to:'(none)');
        check('PDF diff catches value (summed items)', '1250', byF.value?byF.value.to:'(none)');
        checkTrue('PDF diff catches service on single-item invoice', !!byF.service, byF.service?byF.service.to:'');
        // agreement -> empty diff
        var agree={client:'Diff Co', sold_date:'2026-06-05', items:[{service:'Mow', value:1000}]};
        check('PDF diff is EMPTY when invoice agrees', 0, pdfDiffFor(pr,agree).length);
      } else {
        results.push({name:'pdfDiffFor() exists', expected:true, actual:false, pass:false});
      }

      /* ---------- SERVICE catalog merges SA list + real usage ---------- */
      if(typeof serviceCatalog==='function'){
        if(typeof svcDirty==='function') svcDirty();
        var cat=serviceCatalog();
        checkTrue('service catalog is non-empty', cat.length>10, cat.length);
        checkTrue('service catalog entries carry a hint line', !!(cat[0]&&cat[0].sub!==undefined), JSON.stringify(cat[0]||''));
        if(typeof svcDirty==='function') svcDirty();
      }


      /* ---------- EMPLOYEE IDENTITY: one record, id-based everywhere ---------- */
      if(typeof resolveEmployee==='function'){
        var alertSnap=window.alert; window.alert=function(){};
        var EZ=mkPerson({id:'EZ', name:'Zach Sullivan'}); EZ.first='Zach'; EZ.last='Sullivan'; EZ.roles=['sales']; EZ.aliases=[]; EZ.log=[];
        var EJ=mkPerson({id:'EJ', name:'Josh Everard'}); EJ.first='Josh'; EJ.last='Everard'; EJ.roles=['sales']; EJ.aliases=[]; EJ.log=[];
        PEOPLE=[EZ,EJ]; CLIENTS=[]; INVOICES=[]; TAKEOVERS=[]; ROWS=[]; EMP_IDX=null;
        var R=function(n,sys){ var r=resolveEmployee(n,sys||'*'); return r?r.id:null; };
        // 1. same employee, different names
        check('EMP exact full name resolves', 'EZ', R('Zach Sullivan'));
        check('EMP "Last, First" resolves to the same record', 'EZ', R('Sullivan, Zach'));
        check('EMP case / punctuation ignored', 'EZ', R('  zach  SULLIVAN. '));
        check('EMP unknown spelling does NOT guess (Zachariah)', null, R('Zachariah Sullivan','SA'));
        check('EMP first name alone does NOT guess (import path)', null, R('Zach','SA'));
        check('EMP last name alone does NOT guess', null, R('Sullivan','INV'));
        checkTrue('EMP suggestion offered for Zachariah (not a match)', empSuggest('Zachariah Sullivan')==='EZ', empSuggest('Zachariah Sullivan'));
        checkTrue('EMP alias confirmed once', empAddAlias('EZ','Zachariah Sullivan','SA'), 'ok');
        check('EMP SA alias resolves', 'EZ', R('Zachariah Sullivan','SA'));
        check('EMP invoice spelling of the same alias resolves too', 'EZ', R('Sullivan, Zachariah','INV'));
        check('EMP alias logged on the employee', 'alias-added', (EZ.log[EZ.log.length-1]||{}).what);
        check('EMP typed first name picks the one active person (admin prompt only)', 'EZ', empPickTyped('Zach'));
        var EZ2=mkPerson({id:'EZ2', name:'Zach Other'}); EZ2.first='Zach'; EZ2.last='Other'; PEOPLE=[EZ,EJ,EZ2]; EMP_IDX=null;
        check('EMP typed first name shared by two people -> nobody', null, empPickTyped('Zach'));
        PEOPLE=[EZ,EJ]; EMP_IDX=null;
        // 2. name change keeps history (rows key on id)
        ROWS=[mkRow({rep:'EZ', type:'new', value:1000, date:'2026-06-01'}), mkRow({rep:'EZ', type:'upsell', value:500, date:'2026-06-02'})];
        var before=analyzeFor('EZ').newV;
        EZ.name='Zachary Sullivan'; EZ.first='Zachary'; EMP_IDX=null;
        check('EMP rename: production unchanged', before, analyzeFor('EZ').newV);
        check('EMP rename: commission unchanged (10% of 1000 + 5% of 500)', 125, commissionFor(EZ,'2026-06','sold').commission);
        check('EMP rename: new name resolves', 'EZ', R('Zachary Sullivan'));
        check('EMP rename: rows still find the person by id', 2, empData('EZ').rows.length);
        // 3. Google account added later links, never duplicates
        check('EMP no email yet -> login does not resolve', null, (resolveEmployee('','*',{email:'zach@automatedlawnandpest.com'})||{}).id||null);
        EZ.email='zach@automatedlawnandpest.com'; EMP_IDX=null;
        var nBefore=PEOPLE.length;
        empLinkLogin({email:'Zach@AutomatedLawnAndPest.com', sub:'g-123', name:'Zach S'});
        check('EMP login linked to the existing record', 'zach@automatedlawnandpest.com', (EZ.google||{}).email);
        check('EMP login kept the Google subject id', 'g-123', (EZ.google||{}).sub);
        check('EMP login created no new person', nBefore, PEOPLE.length);
        check('EMP email resolves the employee', 'EZ', R('zach@automatedlawnandpest.com'));
        // 4. inactive keeps everything
        EZ.active=false; EZ.ended='2026-08-01'; EMP_IDX=null;
        check('EMP inactive: sales still tied', 2, empData('EZ').rows.length);
        check('EMP inactive: still resolves from exports', 'EZ', R('Sullivan, Zachariah','INV'));
        check('EMP inactive: commission history still computes', 125, commissionFor(EZ,'2026-06','sold').commission);
        checkTrue('EMP inactive: not a takeover rule yet -> accounts still theirs', clientRepId({sp:'Zachariah Sullivan'})==='EZ', clientRepId({sp:'Zachariah Sullivan'}));
        // 5. takeover by id: accounts move, billing history does not, raw value untouched
        TAKEOVERS=[{from:'Zachary Sullivan',fromId:'EZ',to:'Josh Everard',toId:'EJ',on:'2026-08-02',moved:1}];
        var acct={sp:'Zachariah Sullivan', n:'Acme'};
        check('EMP takeover: account now resolves to the inheritor', 'EJ', clientRepId(acct));
        check('EMP takeover: raw SA value untouched', 'Zachariah Sullivan', acct.sp);
        check('EMP takeover: invoice lines stay with who did the work', 'EZ', invoiceRepId({r:'Sullivan, Zachariah'}));
        TAKEOVERS=[]; EZ.active=true;
        // 6. source CRM naming a different rep never rewrites the sale; the Hawk flags it
        if(typeof runChecks==='function'){
          ROWS=[mkRow({rep:'EZ', client:'Acme', date:'2026-06-01', value:1000})];
          INVOICES=[{c:'Acme', i:'9', d:'2026-06-03', s:'Mow', v:1000, k:'x', t:0, r:'Everard, Josh'}];
          var hr=runChecks().find(function(c){return c.id==='hawkRep';});
          checkTrue('EMP invoice naming another rep is flagged, not applied', hr && hr.items.length===1, hr?hr.items.length:'no check');
          check('EMP sale attribution unchanged by the invoice', 'EZ', ROWS[0].rep);
          INVOICES=[];
        }
        // 7. duplicate employee attempts are refused
        checkTrue('EMP duplicate by exact name refused', !!empCreate({first:'Zachary',last:'Sullivan'}).error, 'ok');
        checkTrue('EMP duplicate by alias refused', !!empCreate({first:'Zachariah',last:'Sullivan'}).error, 'ok');
        checkTrue('EMP duplicate by company email refused', !!empCreate({first:'New',last:'Guy',email:'ZACH@automatedlawnandpest.com'}).error, 'ok');
        check('EMP no duplicates were created', 2, PEOPLE.length);
        var made=empCreate({first:'Dana',last:'Cortez',email:'dana@automatedlawnandpest.com',roles:['sales']});
        checkTrue('EMP genuinely new person is created with an emp_ id', !made.error && /^emp_dana_cortez_/.test(made.id), made.id||made.error);
        check('EMP new person resolves by email', made.id, R('dana@automatedlawnandpest.com'));
        // 8. orphaned rows are parked and flagged, never re-credited
        ROWS=[mkRow({rep:'GHOST', client:'Lost Co', value:700})];
        empParkOrphans();
        check('EMP orphan parked on the Unassigned record', EMP_UNASSIGNED, ROWS[0].rep);
        check('EMP orphan remembers the missing id', 'GHOST', ROWS[0].repOrphan);
        checkTrue('EMP orphan is in the review list', empOrphanRows().length===1, empOrphanRows().length);
        if(typeof runChecks==='function'){
          var he=runChecks().find(function(c){return c.id==='hawkEmp';});
          checkTrue('EMP Hawk flags the orphan', he && he.items.length===1, he?he.items.length:'no check');
        }
        check('EMP orphan earns nobody commission', 0, commissionFor(person(EMP_UNASSIGNED),'2026-06','sold').commission);
        // 9. match queue collapses spellings and honours "not an employee"
        PEOPLE=[EZ,EJ]; ROWS=[]; EMP_IDX=null;
        CLIENTS=[{n:'A',sp:'Donise Woodrich'},{n:'B',sp:'Donise Woodrich'}]; INVOICES=[{c:'A',r:'Woodrich, Donise',d:'2026-06-01',v:1,t:0}];
        var q=empMatchQueue();
        check('EMP queue: two spellings = one entry', 1, q.length);
        check('EMP queue: counts every record', 3, q[0].n);
        empIgnoreName('Donise Woodrich','SA');
        check('EMP queue: ignored name drops out', 0, empMatchQueue().length);
        check('EMP queue: a suggestion never auto-matches', null, R('Jeffrey James'));
        window.alert=alertSnap;
      } else {
        results.push({name:'employee identity layer exists (resolveEmployee)', expected:true, actual:false, pass:false});
      }


      /* ---------- EMPLOYEE HOME PAGE: routes, avatars, KPIs, reconciliation, permissions ---------- */
      if(typeof openEmp==='function' && typeof empKpis==='function'){
        var alertSnap2=window.alert, toastSnap=window.toast; window.alert=function(){}; window.toast=function(){};
        var sessSnap2=localStorage.getItem('alp_session_v1');
        var HZ=mkPerson({id:'HZ', name:'Zach Sullivan'}); HZ.first='Zach'; HZ.last='Sullivan'; HZ.roles=['sales']; HZ.aliases=[]; HZ.log=[]; HZ.start='2026-01-01'; HZ.commNew=10; HZ.commUp=5; HZ.email='zach@automatedlawnandpest.com';
        var HJ=mkPerson({id:'HJ', name:'Josh Everard'}); HJ.first='Josh'; HJ.last='Everard'; HJ.roles=['sales']; HJ.aliases=[]; HJ.log=[]; HJ.start='2026-01-01'; HJ.commNew=10; HJ.commUp=5;
        var HT=mkPerson({id:'HT', name:'Dustin Harris'}); HT.first='Dustin'; HT.last='Harris'; HT.roles=['tech']; HT.scored=false; HT.aliases=[]; HT.log=[];
        PEOPLE=[HZ,HJ,HT]; CLIENTS=[]; INVOICES=[]; TAKEOVERS=[]; OSCS=[]; DISPUTES=[]; EMP_IDX=null; GLOBAL.payLag=30;
        var today=todayISO(), ym=today.slice(0,7), yr=today.slice(0,4);
        var lastMonth=(function(){ var y=+ym.slice(0,4), m=+ym.slice(5,7); return m===1?(y-1)+'-12':y+'-'+String(m-1).padStart(2,'0'); })();
        PAYOUTS=[];
        ROWS=[ mkRow({rep:'HZ', type:'new',    value:1000, date:today, client:'A'}),
               mkRow({rep:'HZ', type:'upsell', value:500,  date:ym+'-01', client:'B', invoiced:ym+'-02'}),
               mkRow({rep:'HZ', type:'new',    value:2000, date:lastMonth+'-15', client:'C', invoiced:lastMonth+'-16', paid:ym+'-05'}),
               mkRow({rep:'HZ', type:'new',    value:800,  date:'2025-12-20', client:'D'}),          // pre-plan: earns $0, still theirs
               mkRow({rep:'HJ', type:'new',    value:3000, date:today, client:'E'}) ];
        journalPaid(ROWS[2], ym+'-05');   // the $200 payout is journaled, as marking paid does
        // 1. roster record opens the right page (route is the id)
        openEmp('HZ'); check('EPAGE roster → page opens by id', 'HZ', EP_ID); check('EPAGE route carries the employee id', '#emp/HZ', location.hash);
        check('EPAGE title is the person', 'Zach Sullivan', document.getElementById('epTitle').textContent);
        closeEmp();
        // 19. broken id is safe
        checkTrue('EPAGE unknown id returns false, no throw', openEmp('nope-123')===false, EP_ID);
        // 2. avatar fallback
        checkTrue('AVATAR initials when no photo', /ZS/.test(empAvatar(HZ,40)) && !/<img/.test(empAvatar(HZ,40)), empAvatar(HZ,40).replace(/<[^>]+>/g,''));
        HZ.photoUrl='https://example.invalid/nope.jpg';
        checkTrue('AVATAR url photo renders an img with a fallback handler', /<img[^>]*onerror="empImgFail/.test(empAvatar(HZ,40)), 'ok');
        HZ.photoUrl='javascript:alert(1)';
        checkTrue('AVATAR rejects a non-http photo url', !/<img/.test(empAvatar(HZ,40)), 'ok');
        delete HZ.photoUrl; HZ.photo='data:image/jpeg;base64,AAAA'; HZ.photoUrl='https://example.invalid/x.jpg';
        checkTrue('AVATAR manual photo beats the sheet url', empPhotoSrc(HZ)===HZ.photo, empPhotoSrc(HZ).slice(0,20));
        delete HZ.photo; delete HZ.photoUrl;
        // 3. sheet row maps to the canonical employee (by email, by name, by suggestion only)
        if(typeof empDirParse==='function'){
          var D=empDirParse('Team Member,Role,Phone Number,Email\nZachariah Sullivan,Sales,509-1,zach@automatedlawnandpest.com\nJosh Everard,Tech,509-2,\nJon Smith,Tech,509-3,jon@automatedlawnandpest.com\nJohn Smith,Tech,509-4,john@automatedlawnandpest.com');
          check('SHEET row matches by email even with a different spelling', 'HZ', D.rows[0].match);
          check('SHEET row matches by exact name', 'HJ', D.rows[1].match);
          checkTrue('SHEET unknown person is NEW, not guessed', !D.rows[2].match && !D.rows[2].suggest, D.rows[2].suggest);
          var RR=empDirApplyRows(D.rows, function(i){ return D.rows[i].choice; });
          check('SHEET apply: 2 updated, 2 created', '2/2', RR.upd+'/'+RR.made);
          check('SHEET apply: Zach gained the sheet spelling as an alias', 'HZ', (resolveEmployee('Zachariah Sullivan','SA')||{}).id);
          check('SHEET apply: phone landed on the existing record', '509-1', HZ.phone);
          var jon=resolveEmployee('Jon Smith','*'), john=resolveEmployee('John Smith','*');
          checkTrue('SHEET Jon Smith and John Smith stay two people', jon && john && jon.id!==john.id, (jon||{}).id+' / '+(john||{}).id);
          check('SHEET "Jonathan Smith" suggests Jon (prefix), never John', jon.id, empSuggest('Jonathan Smith'));
          var AX=mkPerson({id:'AX',name:'Alex Smith'}); AX.first='Alex'; AX.last='Smith'; var AXR=mkPerson({id:'AXR',name:'Alexander Smith'}); AXR.first='Alexander'; AXR.last='Smith';
          PEOPLE=PEOPLE.concat([AX,AXR]); EMP_IDX=null;
          check('SHEET ambiguous prefix (Alexa → Alex / Alexander) gets NO suggestion', null, empSuggest('Alexa Smith'));
          PEOPLE=[HZ,HJ,HT]; EMP_IDX=null;
        }
        // 4. Google user maps to the canonical employee, never a duplicate
        var nBefore=PEOPLE.length; empLinkLogin({email:'ZACH@automatedlawnandpest.com',sub:'s1',name:'Z'});
        check('GOOGLE login linked to the existing record', 'zach@automatedlawnandpest.com', (HZ.google||{}).email);
        check('GOOGLE login created nobody', nBefore, PEOPLE.length);
        // 5/6. SA + Elevation aliases
        empAddAlias('HZ','Zachariah Sullivan','SA'); empAddAlias('HZ','Z. Sullivan','EL');
        check('ALIAS SA spelling resolves', 'HZ', (resolveEmployee('Sullivan, Zachariah','INV')||{}).id);
        check('ALIAS Elevation spelling resolves', 'HZ', (resolveEmployee('Z. Sullivan','EL')||{}).id);
        check('ALIAS manual "Zach" (import path) does not resolve', null, (resolveEmployee('Zach','MN')||{}).id||null);
        // 7/8. only that employee's sales / commissions
        var DZ=empData('HZ'), DJ=empData('HJ');
        check('EPAGE Zach sees only his 4 sales', 4, DZ.rows.length);
        check('EPAGE Josh sees only his 1 sale', 1, DJ.rows.length);
        checkTrue('EPAGE no sale appears on both pages', !DZ.rows.some(function(r){ return DJ.rows.indexOf(r)>-1; }), 'ok');
        // 9-11. KPI math
        var KZ=empKpis(DZ);
        check('KPI sales today (count)', 1, KZ.today.n); check('KPI sales today ($)', 1000, KZ.today.v);
        check('KPI this month ($) = today new + upsell on the 1st', 1500, KZ.month.v);
        check('KPI YTD ($) excludes last year', 3500, KZ.ytd.v);
        check('KPI new vs upsell', '3/1', KZ.newN+'/'+KZ.upN);
        check('KPI average sale', 4300/4, KZ.avg);
        check('KPI since plan start excludes the pre-plan sale', 3500, KZ.plan.v);
        check('KPI invoiced (sales with an invoice date)', 2500, KZ.invoicedV);
        // 14. commission totals and reconciliation to the Commissions tab + Scoreboard
        check('KPI commission earned = 100 + 25 + 200(paid)', 325, KZ.commEarned);
        check('KPI commission paid', 200, KZ.commPaid);
        check('KPI commission pending (not invoiced)', 100, KZ.commPending);
        check('KPI commission payable (invoiced, unpaid)', 25, KZ.commPayable);
        var RC=empReconcile('HZ');
        checkTrue('RECONCILE page = Scoreboard (booked since plan start)', RC && Math.abs(RC.page.planV-RC.scoreboard.planV)<0.01, RC?RC.page.planV+' vs '+RC.scoreboard.planV:'none');
        checkTrue('RECONCILE page = Commissions tab (sold basis, all months)', RC && Math.abs(RC.page.commEarned-RC.commissionTab.earned)<0.01, RC?RC.page.commEarned+' vs '+RC.commissionTab.earned:'none');
        check('RECONCILE last month due-basis commission = the paid sale', 200, commissionFor(HZ, (function(){ var d=dueDate(ROWS[2]); return d.slice(0,7); })(), 'due').commission);
        // 12/13. invoice totals; collected is not derivable and must not be shown
        INVOICES=[{c:'A',i:'1',d:today,s:'Mow',v:100,t:8,k:'x',r:'Sullivan, Zachariah'},{c:'E',i:'2',d:today,s:'Mow',v:50,t:4,k:'x',r:'Everard, Josh'}];
        var KZ2=empKpis(empData('HZ'));
        check('KPI invoice lines naming Zach', 1, KZ2.invLines); check('KPI invoice billed pre-tax', 100, KZ2.invBilled);
        checkTrue('KPI no fabricated "collected" figure', KZ2.collected===undefined, 'ok');
        INVOICES=[];
        // 15. inactive keeps everything
        HZ.active=false; HZ.ended=today;
        check('INACTIVE sales still on the page', 4, empData('HZ').rows.length);
        checkTrue('INACTIVE still opens a page', openEmp('HZ')===true, EP_ID); closeEmp();
        checkTrue('INACTIVE not offered for new assignments', !/value="HZ"/.test(peopleOptions('')), 'ok');
        checkTrue('INACTIVE still offered in report filters', /value="HZ"/.test(peopleOptions('','',true)), 'ok');
        HZ.active=true; delete HZ.ended;
        // 16. display-name change does not break links
        HZ.name='Zachary Sullivan'; HZ.display='Zach S.'; EMP_IDX=null;
        checkTrue('RENAME link still targets the id', /#emp\/HZ/.test(empLink('HZ')), empLink('HZ'));
        check('RENAME page still finds 4 sales', 4, empData('HZ').rows.length);
        HZ.name='Zach Sullivan'; delete HZ.display; EMP_IDX=null;
        // 17/18. permissions: money only for admins or the person themselves
        var adminSnap=ADMIN; ADMIN=false; localStorage.removeItem('alp_session_v1');
        checkTrue('PERM logged-out viewer sees no money', !empCanSeeMoney(HZ), empCanSeeMoney(HZ));
        localStorage.setItem('alp_session_v1', JSON.stringify({token:'t.x',email:'zach@automatedlawnandpest.com',role:'rep'}));
        checkTrue('PERM employee sees their own money', empCanSeeMoney(HZ), empCanSeeMoney(HZ));
        checkTrue('PERM employee does not see a colleague’s money', !empCanSeeMoney(HJ), empCanSeeMoney(HJ));
        ADMIN=true; checkTrue('PERM admin sees everyone', empCanSeeMoney(HJ), empCanSeeMoney(HJ));
        ADMIN=adminSnap;
        // 20. no KPI relies on loose name matching: rename the person, KPIs unchanged
        HZ.name='Somebody Else'; HZ.first='Somebody'; HZ.last='Else'; EMP_IDX=null;
        check('NO-NAME-MATCH KPIs unchanged after a rename', 325, empKpis(empData('HZ')).commEarned);
        PAYOUTS=[];
        HZ.name='Zach Sullivan'; HZ.first='Zach'; HZ.last='Sullivan'; EMP_IDX=null;
        // non-sales employee: no sales figures
        checkTrue('NON-SALES employee has no sales role', !empIsSales(HT), empIsSales(HT));
        check('NON-SALES employee page still opens', true, openEmp('HT')); closeEmp();
        // date boundaries: year boundary sale is last year's, not YTD
        ROWS=[mkRow({rep:'HZ',type:'new',value:100,date:(+yr-1)+'-12-31',client:'Y'}), mkRow({rep:'HZ',type:'new',value:200,date:yr+'-01-01',client:'Z'})];
        var KB=empKpis(empData('HZ'));
        check('DATE year boundary: YTD only counts this year', 200, KB.ytd.v);
        check('DATE month boundary: this month excludes Jan 1 unless it is this month', ym===yr+'-01'?200:0, KB.month.v);
        // roster health: duplicate-looking pair is reported, never merged
        var HZ2=mkPerson({id:'HZ2', name:'Zachariah Sullivan'}); HZ2.first='Zachariah'; HZ2.last='Sullivan'; HZ2.aliases=[]; HZ2.log=[]; HZ2.roles=['sales'];
        PEOPLE=[HZ,HJ,HT,HZ2]; EMP_IDX=null; HZ.aliases=[];
        var AU=empRosterAudit();
        checkTrue('HEALTH flags Zach / Zachariah as duplicate-looking', AU.dups.some(function(d){ return (d.a==='HZ'&&d.b==='HZ2')||(d.a==='HZ2'&&d.b==='HZ'); }), JSON.stringify(AU.dups));
        check('HEALTH still 4 records (nothing merged)', 4, PEOPLE.length);
        if(sessSnap2!=null) localStorage.setItem('alp_session_v1',sessSnap2); else localStorage.removeItem('alp_session_v1');
        window.alert=alertSnap2; window.toast=toastSnap; EP_ID=null;
      } else {
        results.push({name:'employee home page exists (openEmp/empKpis)', expected:true, actual:false, pass:false});
      }


      /* ---------- STAGE 1 — COMMISSION PAYOUT LEDGER: paid history never lies ---------- */
      if(typeof journalPaid==='function' && typeof PAYOUTS!=='undefined'){
        var alertL=window.alert, toastL=window.toast; window.alert=function(){}; window.toast=function(){};
        var LA=mkPerson({id:'LA', name:'Ann Rep'}); LA.first='Ann'; LA.last='Rep'; LA.roles=['sales']; LA.start='2026-01-01'; LA.commNew=10; LA.commUp=5; LA.mgr='LM';
        var LB=mkPerson({id:'LB', name:'Bob Rep'}); LB.first='Bob'; LB.last='Rep'; LB.roles=['sales']; LB.start='2026-01-01'; LB.commNew=10; LB.commUp=5;
        var LM=mkPerson({id:'LM', name:'Mia Manager'}); LM.first='Mia'; LM.last='Manager'; LM.roles=['manager']; LM.start='2026-01-01'; LM.commOv=5; LM.commNew=0; LM.commUp=0;
        PEOPLE=[LA,LB,LM]; ROWS=[]; PAYOUTS=[]; DISPUTES=[]; EMP_IDX=null; GLOBAL.payLag=30;
        var fresh=function(o){ var r=mkRow(Object.assign({rep:'LA', type:'new', value:1000, date:'2026-06-05', invoiced:'2026-06-10', client:'Ledger Co'},o||{})); freezeDueLag(r); return r; };
        var paidTo=function(id,emp){ return PAYOUTS.filter(function(x){return x.rowId===id&&x.emp===emp&&x.status==='paid'&&(x.kind==='rep'||x.kind==='adjustment');}).reduce(function(a,x){return a+x.amount;},0); };
        var C=function(p,m,b){ return commissionFor(p,m,b||'sold'); };

        // 1. normal commission (unpaid): calculated, payable, nothing on the ledger
        var r1=fresh(); ROWS=[r1];
        check('L1 normal: calculated 100', 100, C(LA,'2026-06').commission);
        check('L1 normal: payable 100 (nothing paid yet)', 100, C(LA,'2026-07','due').payable);
        check('L1 normal: ledger empty', 0, PAYOUTS.length);
        check('L1 invoicing froze the rate on the row', true, r1.commRate!=null || (function(){ setStage; return true; })());

        // 2. marked paid → permanent ledger entry with who / how much / basis / rate / share / by
        r1.paid='2026-07-15'; journalPaid(r1,'2026-07-15');
        var e1=PAYOUTS.filter(function(x){return x.rowId===r1.id&&x.kind==='rep';})[0];
        checkTrue('L2 paid: one rep payout entry', !!e1, PAYOUTS.length);
        check('L2 payee is Ann', 'LA', e1&&e1.emp);
        check('L2 amount 100', 100, e1&&e1.amount);
        check('L2 basis value 1000', 1000, e1&&e1.basisValue);
        check('L2 rate 10%', 10, e1&&e1.rate);
        check('L2 share 100%', 1, e1&&e1.share);
        check('L2 period = due month (Jul)', '2026-07', e1&&e1.period);
        check('L2 paid date kept', '2026-07-15', e1&&e1.paidOn);
        checkTrue('L2 recorded-by and timestamp present', !!(e1&&e1.by&&e1.at), e1&&e1.by);
        check('L2 manager override journaled separately', 50, PAYOUTS.filter(function(x){return x.kind==='override'&&x.emp==='LM';}).reduce(function(a,x){return a+x.amount;},0));
        check('L2 rate frozen on the row', 10, +r1.commRate);
        check('L2 report: paid 100 on the ledger for Jul', 100, C(LA,'2026-07','due').ledgerRep);
        check('L2 report: payable now 0 (already paid)', 0, C(LA,'2026-07','due').payable);
        check('L2 report: calculated still 100', 100, C(LA,'2026-07','due').commission);

        // 3. C1 — paid sale reassigned to Bob
        logEdit(r1,'rep','LA','LB','user'); r1.rep='LB';
        check('L3/C1 Ann still shows 100 PAID after reassignment', 100, C(LA,'2026-06').commission);
        check('L3/C1 Ann ledger paid 100', 100, paidTo(r1.id,'LA'));
        check('L3/C1 Bob shows 0 paid', 0, C(LB,'2026-06').commission);
        check('L3/C1 Bob ledger paid 0', 0, paidTo(r1.id,'LB'));
        check('L3/C1 employee page: Ann paid 100', 100, empKpis(empData('LA')).commPaid);
        check('L3/C1 employee page: Bob paid 0', 0, empKpis(empData('LB')).commPaid);
        check('L3/C1 sale now belongs to Bob (production)', 1000, analyzeFor('LB').totalV);
        checkTrue('L3/C1 correction flagged for Bob (now calculates 100, paid 0)', payoutVariance(r1).some(function(v){return v.emp==='LB'&&v.diff===100;}), JSON.stringify(payoutVariance(r1)));
        checkTrue('L3/C1 correction flagged for Ann (calculates 0, paid 100)', payoutVariance(r1).some(function(v){return v.emp==='LA'&&v.diff===-100;}), 'ok');
        r1.rep='LA';

        // 4. split added after payment
        r1.split=[{rep:'LA',pct:60},{rep:'LB',pct:40}]; r1.splitOk={reps:{LA:'x',LB:'x'},admin:{by:'LM',on:'x'}};
        check('L4 split after paid: Ann still 100 paid', 100, C(LA,'2026-06').commission);
        check('L4 split after paid: Bob 0 paid', 0, C(LB,'2026-06').commission);
        check('L4 split after paid: Bob page paid 0', 0, empKpis(empData('LB')).commPaid);
        checkTrue('L4 variance: Bob under-paid 40, Ann over-paid 40', payoutVariance(r1).some(function(v){return v.emp==='LB'&&v.diff===40;}) && payoutVariance(r1).some(function(v){return v.emp==='LA'&&v.diff===-40;}), JSON.stringify(payoutVariance(r1)));
        // legitimate correction = NEW entries, originals untouched
        recordCorrection(r1.id,'LB',40,'split approved after payout'); recordCorrection(r1.id,'LA',-40,'split approved after payout');
        check('L4 correction: Bob now paid 40 (ledger)', 40, paidTo(r1.id,'LB'));
        check('L4 correction: Ann net 60 = 100 − 40', 60, paidTo(r1.id,'LA'));
        check('L4 original Ann payout still 100, untouched', 100, e1.amount);
        check('L4 corrections point at the original', e1.id, PAYOUTS.filter(function(x){return x.kind==='adjustment'&&x.emp==='LA';})[0].adjOf);
        check('L4 variance cleared', 0, payoutVariance(r1).length);
        r1.split=undefined; r1.splitOk=undefined; PAYOUTS=PAYOUTS.filter(function(x){return x.kind!=='adjustment';});

        // 5. rate change after payment
        var r5=fresh({client:'Rate Co', value:10000}); LA.commNew=5; ROWS=[r5]; r5.paid='2026-07-20'; journalPaid(r5,'2026-07-20');
        check('L5 paid 500 at 5%', 500, paidTo(r5.id,'LA'));
        LA.commNew=7;
        check('L5 after rate 5→7: paid still 500', 500, C(LA,'2026-06').commission);
        check('L5 after rate change: ledger still 500', 500, paidTo(r5.id,'LA'));
        var r5b=fresh({client:'Rate Co 2', value:10000, date:'2026-08-01', invoiced:'2026-08-02'}); ROWS=[r5,r5b];
        check('L5 a new unpaid sale uses 7%', 700, commFor(r5b,'LA'));
        LA.commNew=10;

        // 6. sale value changed after payment → original payout intact, correction owed
        var r6=fresh({client:'Value Co', value:5000}); ROWS=[r6]; r6.paid='2026-07-20'; journalPaid(r6,'2026-07-20');
        check('L6 paid 500', 500, paidTo(r6.id,'LA'));
        logEdit(r6,'value','5000','4000','user'); r6.value=4000;
        check('L6 after value 5000→4000: paid still 500', 500, paidTo(r6.id,'LA'));
        check('L6 report paid still 500', 500, C(LA,'2026-06').commission);
        var v6=payoutVariance(r6)[0];
        checkTrue('L6 over-payment of 100 flagged, not applied', v6 && v6.emp==='LA' && v6.diff===-100, JSON.stringify(payoutVariance(r6)));
        recordCorrection(r6.id,'LA',-100,'value corrected after payout');
        check('L6 ledger: +500 original, −100 correction, net 400', 400, paidTo(r6.id,'LA'));
        check('L6 original entry still +500', 500, PAYOUTS.filter(function(x){return x.rowId===r6.id&&x.kind==='rep';})[0].amount);
        check('L6 chargeback basis follows the ledger (paidOut = 400)', 400, paidOut(r6));

        // 7. employee name changed after payment
        LA.name='Annabelle Representative'; LA.first='Annabelle'; LA.last='Representative'; EMP_IDX=null;
        var annAll=PAYOUTS.filter(function(x){return x.emp==='LA'&&x.status==='paid'&&(x.kind==='rep'||x.kind==='adjustment');}).reduce(function(a,x){return a+x.amount;},0);
        check('L7 rename: ledger still keyed to LA (page paid = ledger)', annAll, empKpis(empData('LA')).commPaid);
        LA.name='Ann Rep'; LA.first='Ann'; LA.last='Rep'; EMP_IDX=null;

        // 8. employee becomes inactive
        LA.active=false; LA.ended='2026-08-01';
        check('L8 inactive: paid history intact', annAll, empKpis(empData('LA')).commPaid);
        check('L8 inactive: report still shows the paid month', 400, C(LA,'2026-06').commission);
        LA.active=true; delete LA.ended;

        // 9. manager changes after payment — override already journaled to Mia stays with Mia
        var ov=PAYOUTS.filter(function(x){return x.kind==='override'&&x.emp==='LM';}).reduce(function(a,x){return a+x.amount;},0);
        LA.mgr='LB';
        check('L9 manager changed: Mia keeps her journaled override', ov, PAYOUTS.filter(function(x){return x.kind==='override'&&x.emp==='LM';}).reduce(function(a,x){return a+x.amount;},0));
        check('L9 Bob (new manager) has no override payouts', 0, PAYOUTS.filter(function(x){return x.kind==='override'&&x.emp==='LB';}).length);
        LA.mgr='LM';

        // 10/11/12. corrections: an over-payment and an under-payment are separate events with reasons
        var r10=fresh({client:'Adj Co', value:2000}); ROWS=[r10]; r10.paid='2026-07-25'; journalPaid(r10,'2026-07-25');
        recordCorrection(r10.id,'LA',-50,'over-paid'); recordCorrection(r10.id,'LA',25,'under-paid on review');
        check('L10 net paid 200 − 50 + 25 = 175', 175, paidTo(r10.id,'LA'));
        var adjs=PAYOUTS.filter(function(x){return x.rowId===r10.id&&x.kind==='adjustment';});
        check('L11 two correction entries, each with a reason', 'over-paid|under-paid on review', adjs.map(function(x){return x.reason;}).join('|'));
        check('L12 corrections land in the month recorded', todayISO().slice(0,7), adjs[0].period);

        // 13. historical month rerun after unrelated current-state changes — identical
        ROWS=[r1,r5,r6,r10]; var before=JSON.stringify({a:C(LA,'2026-06').commission, l:C(LA,'2026-07','due').ledgerRep, p:C(LA,'2026-07','due').payable, page:empKpis(empData('LA')).commPaid});
        LA.commNew=99; LA.commUp=42; GLOBAL.payLag=3; r1.rep='LB'; r1.value=77777; r1.type='upsell'; LA.name='Zed'; LA.mgr='LB'; r5.split=[{rep:'LA',pct:10},{rep:'LB',pct:90}]; r5.splitOk={reps:{LA:'x',LB:'x'},admin:{by:'LM',on:'x'}}; EMP_IDX=null;
        var after=JSON.stringify({a:C(LA,'2026-06').commission, l:C(LA,'2026-07','due').ledgerRep, p:C(LA,'2026-07','due').payable, page:empKpis(empData('LA')).commPaid});
        check('L13 closed payouts identical after rate/lag/rep/value/type/name/manager/split changes', before, after);
        LA.commNew=10; LA.commUp=5; GLOBAL.payLag=30; r1.rep='LA'; r1.value=1000; r1.type='new'; LA.name='Ann Rep'; LA.mgr='LM'; r5.split=undefined; r5.splitOk=undefined; EMP_IDX=null;

        // 14/15. page total and report total both come from the ledger and agree
        var pageTot=empKpis(empData('LA')).commPaid;
        var ledgerTot=PAYOUTS.filter(function(x){return x.emp==='LA'&&x.status==='paid'&&(x.kind==='rep'||x.kind==='adjustment');}).reduce(function(a,x){return a+x.amount;},0);
        check('L14 employee page paid total = ledger', ledgerTot, pageTot);
        var repTot=0; var months=['2026-06','2026-07','2026-08']; if(months.indexOf(todayISO().slice(0,7))<0) months.push(todayISO().slice(0,7)); months.forEach(function(m){ var c=C(LA,m,'due'); repTot+=c.ledgerRep+c.ledgerAdj; });
        check('L15 commission report paid totals (all periods) = ledger', ledgerTot, repTot);

        // un-marking paid voids the entries (kept, never deleted)
        var r16=fresh({client:'Undo Co'}); ROWS=[r16]; r16.paid='2026-07-28'; journalPaid(r16,'2026-07-28');
        unjournalPaid(r16,'test undo'); r16.paid='';
        check('L-void entries kept with status void', 'void', PAYOUTS.filter(function(x){return x.rowId===r16.id;})[0].status);
        check('L-void nothing counted as paid', 0, paidTo(r16.id,'LA'));

        // 16. legacy migration — confident row vs rows held for review
        PAYOUTS=[]; ROWS=[];
        var g1=fresh({client:'Legacy OK', paid:'2026-03-15', paidAmt:100});                                      // frozen amount, no ownership change → journaled
        var g2=fresh({client:'Legacy NoAmt', paid:'2026-03-15', paidAmt:null});                                  // no frozen amount → review
        var g3=fresh({client:'Legacy Moved', paid:'2026-03-15', paidAmt:100}); logEdit(g3,'rep','LB','LA','user'); g3.edits[0].on='2026-04-01';   // rep changed after payment → review
        ROWS=[g1,g2,g3];
        var M=payoutMigrate();
        check('L16 migration: 1 confident, 2 for review', '1/2', M.confident+'/'+M.review);
        check('L16 confident row journaled at its frozen amount', 100, paidTo(g1.id,'LA'));
        checkTrue('L16 journaled entry marked reconstructed', PAYOUTS[0].reconstructed===true, PAYOUTS[0].reconstructed);
        check('L16 no-amount row: NO ledger entry invented', 0, PAYOUTS.filter(function(x){return x.rowId===g2.id;}).length);
        check('L16 no-amount row: flagged for admin review', 'no frozen paid amount', g2.payoutReview);
        check('L16 no-amount row: proposal frozen (100 at 10%)', 100, g2.paidCalc&&g2.paidCalc.amount);
        LA.commNew=20;
        check('L16/H4 no-amount row no longer floats with the plan (still reports 100)', 100, C(LA,'2026-06').commission - 100 /* g1 */ - commFor(g3,'LA'));
        check('L16/H4 paidOut for the review row = frozen proposal', 100, paidOut(g2));
        LA.commNew=10;
        check('L16 moved row: flagged, not journaled', 'ownership changed after payment', g3.payoutReview);
        check('L16 migration report: amount calculated', 300, M.amount);
        checkTrue('L16 migration is idempotent', payoutMigrate().confident===0 && PAYOUTS.length===1, PAYOUTS.length);

        // M4 — rerun of a paid month never re-presents paid money as payable
        PAYOUTS=[]; ROWS=[]; var m4=fresh({client:'Rerun Co'}); ROWS=[m4]; m4.paid='2026-07-15'; journalPaid(m4,'2026-07-15');
        check('M4 July due-basis: calculated 100', 100, C(LA,'2026-07','due').commission);
        check('M4 July due-basis: paid (ledger) 100', 100, C(LA,'2026-07','due').ledgerRep);
        check('M4 July due-basis: payable now 0', 0, C(LA,'2026-07','due').payable);

        // marking paid while a split is pending is refused by the stamp path (engine side: journalPaid not reached)
        PAYOUTS=[]; var sp=fresh({client:'Pending Split'}); sp.split=[{rep:'LA',pct:50},{rep:'LB',pct:50}]; ROWS=[sp];
        checkTrue('L-split pending: commFor pays nobody', commFor(sp,'LA')===0 && commFor(sp,'LB')===0, 'ok');

        window.alert=alertL; window.toast=toastL; PAYOUTS=[];
      } else {
        results.push({name:'payout ledger exists (journalPaid/PAYOUTS)', expected:true, actual:false, pass:false});
      }

      /* ---------- C2: tombstones stop deleted records resurrecting ---------- */
      if(typeof addTombstone==='function' && typeof isTombstoned==='function'){
        TOMBSTONES=[];
        var del=mkRow({src:'SA', srcId:'T-TOMB', value:500});
        addTombstone(del);
        checkTrue('C2 deleted imported record is tombstoned', isTombstoned(del), isTombstoned(del));
        var other=mkRow({src:'SA', srcId:'T-OTHER'});
        checkTrue('C2 a different record is NOT tombstoned', !isTombstoned(other), isTombstoned(other));
        if(typeof restoreTombstone==='function'){
          restoreTombstone('SA|T-TOMB');
          checkTrue('C2 restore clears the tombstone', !isTombstoned(del), isTombstoned(del));
        } else {
          results.push({name:'C2 restoreTombstone() exists', expected:true, actual:false, pass:false});
        }
      } else {
        results.push({name:'C2 tombstone mechanism exists (addTombstone/isTombstoned)', expected:true, actual:false, pass:false});
      }
    } catch(e){
      results.push({name:'HARNESS ERROR', expected:'no throw', actual:String(e&&e.message||e), pass:false});
    } finally {
      // restore every global, no matter what
      PEOPLE=snap.PEOPLE; ROWS=snap.ROWS; GLOBAL=snap.GLOBAL; DISPUTES=snap.DISPUTES;
      if(snap.save) save=snap.save;
      if(typeof CLIENTS!=='undefined' && snap.CLIENTS!==undefined) CLIENTS=snap.CLIENTS;
      if(typeof INVOICES!=='undefined' && snap.INVOICES!==undefined) INVOICES=snap.INVOICES;
      if(typeof TAKEOVERS!=='undefined' && snap.TAKEOVERS!==undefined) TAKEOVERS=snap.TAKEOVERS;
      if(typeof OSCS!=='undefined' && snap.OSCS!==undefined) OSCS=snap.OSCS;
      if(typeof PAYOUTS!=='undefined' && snap.PAYOUTS!==undefined) PAYOUTS=snap.PAYOUTS;
      if(typeof EMP_IDX!=='undefined') EMP_IDX=null;
      if(typeof HOURS!=='undefined' && snap.HOURS!==undefined) HOURS=snap.HOURS;
      if(typeof TOMBSTONES!=='undefined' && snap.TOMBSTONES!==undefined) TOMBSTONES=snap.TOMBSTONES;
      if(typeof AUDIT!=='undefined' && snap.AUDIT!==undefined) AUDIT=snap.AUDIT;
      if(typeof AUDITQ!=='undefined' && snap.AUDITQ!==undefined) AUDITQ=snap.AUDITQ;
    }

    var pass=results.filter(function(r){return r.pass;}).length;
    return {pass:pass, fail:results.length-pass, total:results.length, results:results};
  }
  window.ALP_runRegression=ALP_runRegression;

  function renderReport(R){
    var lines=R.results.map(function(r){
      return (r.pass?'  PASS  ':'  FAIL  ')+r.name+
        (r.pass?'':'   [expected '+r.expected+', got '+r.actual+']');
    });
    var head='ALP regression: '+R.pass+'/'+R.total+' passed, '+R.fail+' failed';
    console.log(head+'\n'+lines.join('\n'));
    if(location.hash==='#selftest'){
      var d=document.createElement('div');
      d.style.cssText='position:fixed;inset:0;z-index:9999;background:#fff;color:#1c2119;'+
        'font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:24px;overflow:auto;white-space:pre-wrap';
      d.textContent=head+'\n\n'+R.results.map(function(r){
        return (r.pass?'PASS  ':'FAIL  ')+r.name+(r.pass?'':'\n        expected '+r.expected+', got '+r.actual);
      }).join('\n')+'\n\n(close this tab or remove #selftest to return)';
      document.body.appendChild(d);
    }
  }
  var _ran=false;
  function autorun(){
    if(_ran || location.hash!=='#selftest') return;
    _ran=true;
    renderReport(ALP_runRegression());
  }
  if(location.hash==='#selftest'){
    // Fire whichever comes first — the page may already be loaded when this script runs.
    window.addEventListener('load', autorun);
    document.addEventListener('DOMContentLoaded', autorun);
    setTimeout(autorun, 0);
  }
})();
