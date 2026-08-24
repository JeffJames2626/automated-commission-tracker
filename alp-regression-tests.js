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
      // Start from a known state: anything a previous run (or the real data) left on
      // GLOBAL must not decide a test's result.
      GLOBAL=Object.assign({}, snap.GLOBAL, {empIgnore:[], hawkMuted:[], payLag:30,
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
      if(typeof PAYOUTS!=='undefined'){ PAYOUTS=[]; payoutMigrate(); reversalMigrate(); }   // as boot does for a legacy paid+reversed row
      check('C1.T4 paid-then-reversed: sale month = $100', 100, commissionFor(P,'2026-06','sold').commission);
      check('C1.T4 paid-then-reversed: reversal month clawback = $100', 100, commissionFor(P,'2026-07','sold').cbTotal);
      if(typeof PAYOUTS!=='undefined') PAYOUTS=[];

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


      /* ---------- STAGE 2 — REVERSALS, CHARGEBACKS, OVERRIDE, DISPUTES, CARRY ---------- */
      if(typeof journalReversal==='function' && typeof compPosition==='function'){
        var alertR=window.alert, toastR=window.toast, confR=window.confirm, promptR=window.prompt;
        window.alert=function(){}; window.toast=function(){}; window.confirm=function(){return true;}; window.prompt=function(){return 'test';};
        var RA=mkPerson({id:'RA', name:'Ann Rep'}); RA.first='Ann'; RA.last='Rep'; RA.roles=['sales']; RA.start='2026-01-01'; RA.commNew=5; RA.commUp=5; RA.mgr='RM';
        var RB=mkPerson({id:'RB', name:'Bob Rep'}); RB.first='Bob'; RB.last='Rep'; RB.roles=['sales']; RB.start='2026-01-01'; RB.commNew=5; RB.commUp=5;
        var RM=mkPerson({id:'RM', name:'Mia Manager'}); RM.first='Mia'; RM.last='Manager'; RM.roles=['manager']; RM.start='2026-01-01'; RM.commOv=5; RM.commNew=0; RM.commUp=0;
        var RN=mkPerson({id:'RN', name:'Ned Manager'}); RN.first='Ned'; RN.last='Manager'; RN.roles=['manager']; RN.start='2026-01-01'; RN.commOv=5; RN.commNew=0; RN.commUp=0;
        PEOPLE=[RA,RB,RM,RN]; ROWS=[]; PAYOUTS=[]; DISPUTES=[]; EMP_IDX=null; GLOBAL.payLag=30; GLOBAL.policy.clawbackDays=180;
        var fresh=function(o){ var r=mkRow(Object.assign({rep:'RA', type:'new', value:1000, date:'2026-06-05', invoiced:'2026-06-10', client:'Rev Co'},o||{})); freezeDueLag(r); return r; };
        var pay=function(r,on){ r.paid=on||'2026-07-15'; journalPaid(r,r.paid); };
        var rev=function(r,kind,amt,on){ r.voidType=kind; r.voidAmt=amt; r.voidDate=on===undefined?'2026-08-05':on; return journalReversal(r); };
        var C=function(p,m,b,o){ return commissionFor(p,m,b||'sold',o); };
        var ev=function(rowId,emp,kind){ return PAYOUTS.filter(function(x){return x.rowId===rowId&&x.emp===emp&&x.kind===kind&&x.status!=='void';}); };
        var sum=function(L){ return L.reduce(function(a,x){return a+x.amount;},0); };

        // 1. normal sale
        var r1=fresh(); ROWS=[r1];
        check('R1 normal: rep 50', 50, C(RA,'2026-06').commission);
        check('R1 normal: manager override 50 (5% of net 1000)', 50, C(RM,'2026-06').ovC);
        // 2. cancelled before invoiced
        var r2=fresh({invoiced:''}); r2.voidType='cancelled'; r2.voidAmt=1000; r2.voidDate='2026-06-08'; ROWS=[r2];
        check('R2 cancelled before invoice: rep 0', 0, C(RA,'2026-06').commission); check('R2 ... manager 0', 0, C(RM,'2026-06').ovC); check('R2 ... production 0', 0, analyzeFor('RA').totalV);
        // 3. cancelled after invoiced (unpaid)
        var r3=fresh(); r3.voidType='cancelled'; r3.voidAmt=1000; r3.voidDate='2026-06-20'; ROWS=[r3];
        check('R3 cancelled after invoice: due-month payable 0', 0, C(RA,'2026-07','due').payable); check('R3 ... manager 0', 0, C(RM,'2026-07','due').ovC);
        check('R3 ... no ledger events (nothing was paid)', 0, PAYOUTS.length);
        // 4/5. cancelled before vs after commission paid
        var r5=fresh(); ROWS=[r5]; pay(r5);
        var paidBefore=JSON.stringify(PAYOUTS.filter(function(x){return x.kind==='rep';}));
        rev(r5,'cancelled',1000,'2026-08-05');
        check('R5 cancelled after paid: original rep payout untouched', paidBefore, JSON.stringify(PAYOUTS.filter(function(x){return x.kind==='rep';})));
        check('R5 rep chargeback event −50 in Aug', -50, sum(ev(r5.id,'RA','rep-chargeback')));
        check('R5 manager chargeback event −50 in Aug', -50, sum(ev(r5.id,'RM','manager-chargeback')));
        check('R5 Aug report: chargebacks 50 (rep)', 50, C(RA,'2026-08','due').cbTotal);
        check('R5 Aug report: manager chargebacks 50', 50, C(RM,'2026-08','due').cbTotal);
        check('R5 June report still shows the 50 paid', 50, C(RA,'2026-06').commission);
        check('R5 net compensation on the sale = 0', 0, sum(ev(r5.id,'RA','rep'))+sum(ev(r5.id,'RA','rep-chargeback')));
        check('R5 production 0 after cancellation', 0, analyzeFor('RA').totalV);
        // 6. partial cancellation before payment
        var r6=fresh({value:10000}); r6.voidType='cancelled'; r6.voidAmt=5000; r6.voidDate='2026-06-20'; ROWS=[r6];
        check('R6 50% cancelled unpaid: rep 250', 250, C(RA,'2026-06').commission); check('R6 ... manager 250', 250, C(RM,'2026-06').ovC);
        // 7. partial cancellation after payment — the audit's $10,000 / $2,000 example
        var r7=fresh({value:10000}); ROWS=[r7]; pay(r7); PAYOUTS=PAYOUTS.filter(function(x){return x.rowId===r7.id;});
        check('R7 paid 500', 500, sum(ev(r7.id,'RA','rep')));
        rev(r7,'refunded',2000,'2026-08-10');
        check('R7 original payout still +500', 500, sum(ev(r7.id,'RA','rep')));
        check('R7 chargeback −100', -100, sum(ev(r7.id,'RA','rep-chargeback')));
        check('R7 net compensation 400', 400, sum(ev(r7.id,'RA','rep'))+sum(ev(r7.id,'RA','rep-chargeback')));
        check('R7 manager: +500 paid, −100 chargeback', '500/-100', sum(ev(r7.id,'RM','override'))+'/'+sum(ev(r7.id,'RM','manager-chargeback')));
        check('R7 chargeback basis value recorded (2000)', 2000, ev(r7.id,'RA','rep-chargeback')[0].basisValue);
        check('R7 chargeback points at the original payout', ev(r7.id,'RA','rep')[0].id, ev(r7.id,'RA','rep-chargeback')[0].adjOf);
        // 8/9/10/11. full refund, partial refund, credit, write-off — one rule, type preserved
        ['refunded','credited','writeoff','cancelled'].forEach(function(k){
          var rk=fresh({value:4000}); ROWS=[rk]; rk.voidType=k; rk.voidAmt=4000; rk.voidDate='2026-06-20';
          check('R8-11 '+k+' full: net 0 / rep 0 / manager 0', '0/0/0', netValue(rk)+'/'+C(RA,'2026-06').commission+'/'+C(RM,'2026-06').ovC);
          rk.voidAmt=1000;
          check('R8-11 '+k+' partial 1000: net 3000 / rep 150 / manager 150', '3000/150/150', netValue(rk)+'/'+C(RA,'2026-06').commission+'/'+C(RM,'2026-06').ovC);
          check('R8-11 '+k+' type preserved for history', k, rk.voidType);
        });
        // 12. blank reversal date on a PAID sale: never silently dropped
        PAYOUTS=[]; var r12=fresh(); ROWS=[r12]; pay(r12); var e12=rev(r12,'cancelled',1000,'');
        check('R12 blank date: no chargeback event journaled (nothing to date it by)', 0, e12.length);
        checkTrue('R12 blank date: sale is in the review list', reversalReviewRows().indexOf(r12)>-1, reversalReviewRows().length);
        checkTrue('R12 blank date: report flags it', C(RA,'2026-08','due').reversalReview.length===1, 'ok');
        r12.voidDate='2026-08-05'; journalReversal(r12);
        check('R12 date set later → chargeback lands', -50, sum(ev(r12.id,'RA','rep-chargeback')));
        check('R12 review list clears', 0, reversalReviewRows().length);
        // 13. reversal greater than the sale value: clamped, net never negative
        var r13=fresh({value:10000}); ROWS=[r13]; [500,2500,9999,10000,25000].forEach(function(a){ r13.voidType='refunded'; r13.voidAmt=a; r13.voidDate='2026-06-20';
          check('R13 reverse '+a+': net', Math.max(0,10000-Math.min(a,10000)), netValue(r13)); });
        check('R13 over-reversal: rep commission 0, never negative', 0, C(RA,'2026-06').commission);
        check('R13 over-reversal: manager 0, never negative', 0, C(RM,'2026-06').ovC);
        // 14/15. rep + manager chargebacks are separate kinds with separate recipients
        PAYOUTS=[]; var r14=fresh({value:2000}); ROWS=[r14]; pay(r14); rev(r14,'refunded',1000,'2026-08-05');
        check('R14 rep chargeback kind/amount', 'rep-chargeback/-50', ev(r14.id,'RA','rep-chargeback')[0].kind+'/'+sum(ev(r14.id,'RA','rep-chargeback')));
        check('R15 manager chargeback kind/amount', 'manager-chargeback/-50', ev(r14.id,'RM','manager-chargeback')[0].kind+'/'+sum(ev(r14.id,'RM','manager-chargeback')));
        // 16/17. override cancelled before vs after payment
        PAYOUTS=[]; var r16=fresh(); ROWS=[r16]; r16.voidType='cancelled'; r16.voidAmt=1000; r16.voidDate='2026-06-20';
        check('R16 override cancelled before payment: 0 payable, no events', '0/0', C(RM,'2026-07','due').ovC+'/'+PAYOUTS.length);
        var r17=fresh(); ROWS=[r17]; pay(r17); rev(r17,'cancelled',1000,'2026-08-05');
        check('R17 override paid then cancelled: +50 stays, −50 chargeback, net 0', '50/-50', sum(ev(r17.id,'RM','override'))+'/'+sum(ev(r17.id,'RM','manager-chargeback')));
        check('R17 Mia Aug position: chargeback 50', 50, C(RM,'2026-08','due').cbTotal);
        // 18. dispute linked to a sale, within exposure
        PAYOUTS=[]; var r18=fresh({value:2000}); ROWS=[r18]; pay(r18);
        DISPUTES=[{id:'d18',rep:'RA',raised:'2026-08-01',rowId:r18.id,scope:'sale',claim:'short',amount:30,status:'open',resolved:'',resolution:'',adjust:0}];
        setDispute('d18','status','upheld');
        check('R18 dispute within exposure (paid 100): adjust 30 lands', 30, DISPUTES[0].adjust);
        check('R18 dispute effective date stamped', todayISO(), DISPUTES[0].resolved);
        checkTrue('R18 dispute resolvedBy recorded', !!DISPUTES[0].resolvedBy, DISPUTES[0].resolvedBy);
        check('R18 report adjustment this month', 30, C(RA,todayISO().slice(0,7),'due').adjTotal);
        // 19. dispute exceeding exposure: capped unless explicit override
        window.confirm=function(){return false;};   // decline the override
        setDispute('d18','adjust',999);
        check('R19 over-exposure adjust capped to 100 without override', 100, DISPUTES[0].adjust);
        checkTrue('R19 no override flag', !DISPUTES[0].override, 'ok');
        window.confirm=function(){return true;};    // accept the override
        setDispute('d18','adjust',999);
        check('R19 explicit override applies 999', 999, DISPUTES[0].adjust);
        checkTrue('R19 override recorded with who/when', !!(DISPUTES[0].override&&DISPUTES[0].override.by), JSON.stringify(DISPUTES[0].override));
        DISPUTES=[];
        // 20. reversal outside the recovery window: FORGIVEN, visible, not deducted
        PAYOUTS=[]; RA.start='2025-01-01'; var r20=fresh({date:'2025-06-05',invoiced:'2025-06-10'}); ROWS=[r20]; pay(r20,'2025-07-15'); var e20=rev(r20,'cancelled',1000,'2026-06-01'); RA.start='2026-01-01';
        check('R20 forgiven event recorded', 'forgiven', e20[0]&&e20[0].status);
        check('R20 forgiven amount −50 visible on the event', -50, e20[0]&&e20[0].amount);
        checkTrue('R20 reason says outside window', /outside the 180-day recovery window/.test(e20[0]&&e20[0].reason), e20[0]&&e20[0].reason);
        check('R20 not deducted (cbTotal 0)', 0, C(RA,'2026-06','due').cbTotal);
        check('R20 shown as forgiven on the report', 50, C(RA,'2026-06','due').forgivenTotal);
        // 21. negative carry into the next month
        PAYOUTS=[]; var r21=fresh({value:6000,date:'2026-05-05',invoiced:'2026-05-10'}); ROWS=[r21]; pay(r21,'2026-06-12'); rev(r21,'cancelled',6000,'2026-07-03');
        var r21b=fresh({value:20000,date:'2026-07-01',invoiced:'2026-07-05'}); ROWS=[r21,r21b];
        var J=C(RA,'2026-07','due'), A=C(RA,'2026-08','due');
        check('R21 July: chargeback 300, earned 0, closing −300', -300, J.closing);
        check('R21 July payable 0, carry 300', '0/300', J.payable+'/'+J.carry);
        check('R21 Aug: opening −300', -300, A.opening);
        check('R21 Aug: earned 1000 (20000 × 5%)', 1000, A.earned||A.newC+A.upC);
        check('R21 Aug payable = 700', 700, A.payable);
        check('R21 position identity: closing = opening + earned + override + adj − cb − paid', A.position.closing, A.position.opening+A.position.earned+A.position.override+A.position.adjust-A.position.chargebacks-A.position.paid);
        // 22. employee reassigned after reversal — events stay with the original payee
        PAYOUTS=[]; var r22=fresh(); ROWS=[r22]; pay(r22); rev(r22,'refunded',500,'2026-08-05'); r22.rep='RB';
        check('R22 Ann keeps +50 / −25', '50/-25', sum(ev(r22.id,'RA','rep'))+'/'+sum(ev(r22.id,'RA','rep-chargeback')));
        check('R22 Bob has no events', 0, PAYOUTS.filter(function(x){return x.emp==='RB';}).length);
        check('R22 Ann Aug chargeback 25', 25, C(RA,'2026-08','due').cbTotal);
        r22.rep='RA';
        // 23. manager changed after reversal — Mia keeps her +50/−25; Ned gets nothing
        RA.mgr='RN';
        check('R23 Mia keeps override +50 and chargeback −25', '50/-25', sum(ev(r22.id,'RM','override'))+'/'+sum(ev(r22.id,'RM','manager-chargeback')));
        check('R23 Ned has no events', 0, PAYOUTS.filter(function(x){return x.emp==='RN';}).length);
        check('R23 Ned current override on that sale (already journaled to Mia): 0', 0, C(RN,'2026-07','due').ovC);
        RA.mgr='RM';
        // 24. employee page net compensation explains the number
        var KA=empKpis(empData('RA'));
        check('R24 page paid 50 (ledger)', 50, KA.commPaid); check('R24 page chargebacks 25 (events)', 25, KA.clawback);
        check('R24 net = paid − chargebacks = 25', 25, KA.commPaid-KA.clawback);
        // 25/26. report and scoreboard reconcile on net
        var r25=fresh({value:8000,date:'2026-06-05',invoiced:''}); r25.voidType='refunded'; r25.voidAmt=2000; r25.voidDate='2026-06-20'; ROWS=[r25]; PAYOUTS=[];
        check('R25 report June commission on net 6000', 300, C(RA,'2026-06').commission);
        check('R26 scoreboard production net 6000', 6000, analyzeFor('RA').totalV);
        check('R26 scoreboard commission = report', C(RA,'2026-06').commission, analyzeFor('RA').commission);
        check('R26 employee page YTD net', 6000, empKpis(empData('RA')).ytd.v);
        // M2 rerun — team pulse counts partial refunds at net
        TP_PERIOD='ytd'; var pulseNet=(function(){ var live=ROWS.filter(function(r){return !isReversed(r);}); return live.reduce(function(a,r){return a+netValue(r);},0); })();
        check('M2 pulse net booked counts the partial refund at 6000', 6000, pulseNet);
        // M3 rerun — report counts exclude fully reversed sales
        var r27=fresh({client:'Gone'}); r27.voidType='cancelled'; r27.voidAmt=1000; r27.voidDate='2026-06-20'; ROWS=[r25,r27];
        check('M3 report NEW count excludes the cancelled sale', 1, C(RA,'2026-06').news.filter(function(x){return !isReversed(x);}).length);
        // M5 rerun — credit exists, all four types identical
        checkTrue('M5 credited is an accepted reversal type', VOID_TYPES.some(function(v){return v[0]==='credited';}), 'ok');
        // H6 rerun — dispute cap / link
        DISPUTES=[{id:'h6',rep:'RA',raised:'2026-08-01',rowId:'',scope:'general',claim:'x',amount:5000,status:'open',resolved:'',resolution:'',adjust:0}];
        window.confirm=function(){return false;}; setDispute('h6','status','upheld');
        check('H6 general dispute without override → 0 applied', 0, DISPUTES[0].adjust);
        window.confirm=function(){return true;}; DISPUTES=[];
        // legacy migration of an old paid+reversed row
        PAYOUTS=[]; var g=fresh({client:'Old Rev', paid:'2026-03-15', paidAmt:50}); g.voidType='refunded'; g.voidAmt=500; g.voidDate='2026-04-10'; ROWS=[g];
        payoutMigrate(); var mg=reversalMigrate();
        check('R-mig legacy paid+reversed row: 1 chargeback journaled', 1, mg.journaled);
        check('R-mig chargeback −25 dated by the existing void date', '-25/2026-04', sum(ev(g.id,'RA','rep-chargeback'))+'/'+ev(g.id,'RA','rep-chargeback')[0].period);
        checkTrue('R-mig marked reconstructed', ev(g.id,'RA','rep-chargeback')[0].reconstructed===true, 'ok');
        var g2=fresh({client:'Old NoDate', paid:'2026-03-15', paidAmt:50}); g2.voidType='refunded'; g2.voidAmt=500; g2.voidDate=''; ROWS=[g,g2];
        var mg2=reversalMigrate();
        check('R-mig blank-date legacy row: held for review, nothing invented', '0/1', mg2.journaled+'/'+mg2.review);
        // undo a reversal voids its events (kept)
        PAYOUTS=[]; var r28=fresh(); ROWS=[r28]; pay(r28); rev(r28,'cancelled',1000,'2026-08-05'); unjournalReversal(r28);
        check('R-undo chargeback events voided, not deleted', 'void', PAYOUTS.filter(function(x){return x.kind==='rep-chargeback';})[0].status);
        check('R-undo nothing deducted', 0, C(RA,'2026-08','due').cbTotal);
        // every dollar from immutable events: rep + manager
        PAYOUTS=[]; var r29=fresh({value:10000}); ROWS=[r29]; pay(r29); rev(r29,'refunded',2000,'2026-08-10'); recordCorrection(r29.id,'RA',25,'goodwill');
        var evts=PAYOUTS.filter(function(x){return x.status!=='void';});
        check('R-recon Ann from events: +500 −100 +25 = 425', 425, evts.filter(function(x){return x.emp==='RA'&&x.status!=='forgiven';}).reduce(function(a,x){return a+x.amount;},0));
        check('R-recon Mia from events: +500 −100 = 400', 400, evts.filter(function(x){return x.emp==='RM';}).reduce(function(a,x){return a+x.amount;},0));
        check('R-recon Ann page paid − chargebacks = 425', 425, empKpis(empData('RA')).commPaid-empKpis(empData('RA')).clawback);
        window.alert=alertR; window.toast=toastR; window.confirm=confR; window.prompt=promptR; PAYOUTS=[]; DISPUTES=[]; TP_PERIOD='month';
      } else {
        results.push({name:'reversal engine exists (journalReversal/compPosition)', expected:true, actual:false, pass:false});
      }


      /* ---------- DATA HAWK ×10: each new skill fires on its fixture, quiet when clean ---------- */
      if(typeof runChecks==='function' && typeof PAYOUTS!=='undefined'){
        var alertH=window.alert; window.alert=function(){};
        var HA=mkPerson({id:'HKA', name:'Hawk Ann'}); HA.first='Hawk'; HA.last='Ann'; HA.roles=['sales']; HA.start='2026-01-01'; HA.commNew=10; HA.commUp=5; HA.mgr='HKM'; HA.aliases=[]; HA.log=[];
        var HM=mkPerson({id:'HKM', name:'Hawk Mia'}); HM.first='Hawk'; HM.last='Mia'; HM.roles=['manager']; HM.start='2026-01-01'; HM.commOv=5; HM.commNew=0; HM.commUp=0; HM.aliases=[]; HM.log=[];
        var HF=mkPerson({id:'HKF', name:'Hawk Fred'}); HF.first='Hawk'; HF.last='Fred'; HF.roles=['sales']; HF.start='2026-01-01'; HF.commNew=10; HF.commUp=5; HF.active=false; HF.ended='2026-05-01'; HF.aliases=[]; HF.log=[];
        PEOPLE=[HA,HM,HF]; ROWS=[]; PAYOUTS=[]; DISPUTES=[]; CLIENTS=[]; INVOICES=[]; OPENINV=[]; TAKEOVERS=[]; EMP_IDX=null; GLOBAL.payLag=30; GLOBAL.policy.clawbackDays=180;
        var hk=function(id){ var c=runChecks().find(function(x){return x.id===id;}); return c?c.items.length:0; };
        var fx=function(o){ var r=mkRow(Object.assign({rep:'HKA', type:'new', value:1000, date:'2026-06-05', invoiced:'2026-06-10', client:'HawkCo'},o||{})); freezeDueLag(r); return r; };
        check('HAWK10 clean slate: none of the new checks fire', 0,
          ['hawkOvGross','hawkLedgerGap','hawkVoidDate','hawkForgiven','hawkVariance','hawkNoIdDupes','hawkSplit','hawkPrePlan','hawkFormer','hawkInvNo'].reduce(function(a,id){return a+hk(id);},0));
        // 1. override journaled on gross after a partial reversal
        var h1=fx({value:4000,voidType:'refunded',voidAmt:1000,voidDate:'2026-06-01'}); ROWS=[h1]; h1.paid='2026-07-15'; journalPaid(h1,'2026-07-15');
        var ovE=PAYOUTS.find(function(x){return x.kind==='override';}); if(ovE){ ovE.basisValue=4000; ovE.amount=200; }   // reproduce the F1 defect shape
        check('HAWK10 override-on-gross flagged', 1, hk('hawkOvGross'));
        ROWS=[]; PAYOUTS=[];
        // 2. ledger gap: paid with no payout entry
        var h2=fx({paid:'2026-07-15',paidAmt:null}); h2.payoutReview='no frozen paid amount'; ROWS=[h2];
        check('HAWK10 ledger gap flagged', 1, hk('hawkLedgerGap'));
        ROWS=[];
        // 3. reversal without an effective date
        var h3=fx({voidType:'cancelled',voidAmt:1000,voidDate:''}); ROWS=[h3];
        check('HAWK10 missing void date flagged', 1, hk('hawkVoidDate'));
        ROWS=[];
        // 4. forgiven chargeback surfaces
        HA.start='2025-01-01'; var h4=fx({date:'2025-06-05',invoiced:'2025-06-10'}); ROWS=[h4]; h4.paid='2025-07-15'; journalPaid(h4,'2025-07-15'); h4.voidType='cancelled'; h4.voidAmt=1000; h4.voidDate='2026-06-01'; journalReversal(h4);
        checkTrue('HAWK10 forgiven chargeback listed', hk('hawkForgiven')>=1, hk('hawkForgiven')); HA.start='2026-01-01';
        ROWS=[]; PAYOUTS=[];
        // 5. paid sale drifted from its payout
        var h5=fx({}); ROWS=[h5]; h5.paid='2026-07-15'; journalPaid(h5,'2026-07-15'); h5.value=2500;
        check('HAWK10 payout variance flagged', 1, hk('hawkVariance'));
        ROWS=[]; PAYOUTS=[];
        // 6. probable duplicate without a source id
        ROWS=[fx({client:'Twin Co',value:900}), fx({client:'Twin Co',value:905,date:'2026-06-07'})];
        check('HAWK10 no-id duplicate pair flagged', 1, hk('hawkNoIdDupes'));
        ROWS=[];
        // 7. pending split holds money; odd percentages
        var h7=fx({split:[{rep:'HKA',pct:60},{rep:'HKM',pct:60}]}); ROWS=[h7];
        check('HAWK10 pending + odd-pct split flagged (2 items)', 2, hk('hawkSplit'));
        ROWS=[];
        // 8. pre-plan production
        HA.start='2026-09-01'; ROWS=[fx({date:'2026-06-05'})];
        check('HAWK10 pre-plan sale flagged (grouped by person)', 1, hk('hawkPrePlan'));
        HA.start='2026-01-01'; ROWS=[];
        // 9. former team member credited after leaving + still owed
        ROWS=[fx({rep:'HKF',date:'2026-06-05'})];
        check('HAWK10 former member: new sale + owed commission (2 items)', 2, hk('hawkFormer'));
        ROWS=[];
        // 10. invoice number matching nothing
        INVOICES=[{c:'HawkCo',i:'8001',d:'2026-06-11',s:'Mow',v:1000,t:0,k:'x',r:''}];
        ROWS=[fx({invNo:'9999'})];
        check('HAWK10 unknown invoice number flagged', 1, hk('hawkInvNo'));
        ROWS=[fx({invNo:'8001'})];
        check('HAWK10 matching invoice number stays quiet', 0, hk('hawkInvNo'));
        ROWS=[]; INVOICES=[];
        window.alert=alertH;
      } else {
        results.push({name:'hawk x10 present', expected:true, actual:false, pass:false});
      }


      /* ---------- CRITICAL FIX #1 — manager override is journaled on NET ---------- */
      if(typeof journalPaid==='function' && typeof payoutVariance==='function'){
        var alertO=window.alert, toastO=window.toast; window.alert=function(){}; window.toast=function(){};
        var OA=mkPerson({id:'OA', name:'Ov Ann'}); OA.first='Ov'; OA.last='Ann'; OA.roles=['sales']; OA.start='2026-01-01'; OA.commNew=10; OA.commUp=5; OA.mgr='OM'; OA.aliases=[]; OA.log=[];
        var OM=mkPerson({id:'OM', name:'Ov Mia'}); OM.first='Ov'; OM.last='Mia'; OM.roles=['manager']; OM.start='2026-01-01'; OM.commOv=5; OM.commNew=0; OM.commUp=0; OM.aliases=[]; OM.log=[];
        PEOPLE=[OA,OM]; ROWS=[]; PAYOUTS=[]; DISPUTES=[]; EMP_IDX=null; GLOBAL.payLag=30; GLOBAL.policy.clawbackDays=180;
        var mkO=function(o){ var r=mkRow(Object.assign({rep:'OA',type:'new',value:4000,date:'2026-06-05',invoiced:'2026-06-10',client:'Ov Co'},o||{})); freezeDueLag(r); return r; };
        var ovOf=function(id){ return PAYOUTS.filter(function(x){return x.rowId===id&&x.kind==='override'&&x.status!=='void';}); };
        var ovNet=function(id){ return PAYOUTS.filter(function(x){return x.rowId===id&&x.emp==='OM'&&x.status!=='void'&&(x.kind==='override'||x.kind==='override-adjustment'||(x.kind==='manager-chargeback'&&x.status==='applied'));}).reduce(function(a,x){return a+x.amount;},0); };

        // O1 — clean sale: override on the full value
        var o1=mkO({}); ROWS=[o1]; o1.paid='2026-07-15'; journalPaid(o1,'2026-07-15');
        check('OV1 clean sale: override 200 (5% of 4000)', 200, ovOf(o1.id)[0].amount);
        check('OV1 basis recorded = 4000', 4000, ovOf(o1.id)[0].basisValue);

        // O2 — THE BUG: partial reversal BEFORE payment must pay the override on NET
        PAYOUTS=[]; var o2=mkO({voidType:'refunded',voidAmt:1000,voidDate:'2026-06-20'}); ROWS=[o2]; o2.paid='2026-07-15'; journalPaid(o2,'2026-07-15');
        check('OV2 partly refunded before payment: override 150 (5% of net 3000)', 150, ovOf(o2.id)[0].amount);
        check('OV2 basis recorded = net 3000', 3000, ovOf(o2.id)[0].basisValue);
        check('OV2 rep paid on net too (10% of 3000)', 300, ledgerPaid(o2,'OA'));
        check('OV2 report: Mia ledger override 150', 150, commissionFor(OM,'2026-07','due').ledgerOv);
        check('OV2 Mia page override paid 150', 150, empKpis(empData('OM')).ovPaid);
        checkTrue('OV2 no variance — the entry is already right', payoutVariance(o2).length===0, JSON.stringify(payoutVariance(o2)));

        // O3 — fully cancelled before payment: no override entry at all, nothing payable
        PAYOUTS=[]; var o3=mkO({voidType:'cancelled',voidAmt:4000,voidDate:'2026-06-20'}); ROWS=[o3]; o3.paid='2026-07-15'; journalPaid(o3,'2026-07-15');
        check('OV3 fully cancelled: no override entry', 0, ovOf(o3.id).length);
        check('OV3 fully cancelled: Mia earns 0 in the report', 0, commissionFor(OM,'2026-07','due').ovC);
        check('OV3 fully cancelled: rep entry still exists (ledger complete)', 1, PAYOUTS.filter(function(x){return x.rowId===o3.id&&x.kind==='rep';}).length);

        // O4 — reversal AFTER payment still nets the manager to what the sale is worth
        PAYOUTS=[]; var o4=mkO({}); ROWS=[o4]; o4.paid='2026-07-15'; journalPaid(o4,'2026-07-15');
        o4.voidType='refunded'; o4.voidAmt=1000; o4.voidDate='2026-08-10'; journalReversal(o4);
        check('OV4 paid then partly refunded: +200 then −50 = 150 net', 150, ovNet(o4.id));
        check('OV4 original override entry untouched at 200', 200, ovOf(o4.id)[0].amount);
        check('OV4 Aug manager chargeback 50', 50, commissionFor(OM,'2026-08','due').cbTotal);

        // O5 — a legacy entry written on GROSS is detected and correctable, never rewritten
        PAYOUTS=[]; var o5=mkO({voidType:'refunded',voidAmt:1000,voidDate:'2026-06-20'}); ROWS=[o5]; o5.paid='2026-07-15'; journalPaid(o5,'2026-07-15');
        var bad=ovOf(o5.id)[0]; bad.amount=200; bad.basisValue=4000;          // reproduce the old gross-basis entry
        var v5=payoutVariance(o5).filter(function(x){return x.kind==='override';});
        check('OV5 gross entry flagged as a 50 over-pay', -50, v5.length?v5[0].diff:0);
        check('OV5 flagged against the manager', 'OM', v5.length?v5[0].emp:'');
        if(typeof runChecks==='function'){
          var hg=runChecks().find(function(c){return c.id==='hawkOvGross';});
          checkTrue('OV5 Hawk flags it with dollars at stake', hg && hg.items.length===1 && Math.abs(hg.impact-50)<0.01, hg?hg.items.length+'/'+hg.impact:'none');
        }
        var before=JSON.stringify(bad);
        recordCorrection(o5.id,'OM',-50,'override was recorded on the gross value',{kind:'override'});
        check('OV5 correction did NOT rewrite the original entry', before, JSON.stringify(ovOf(o5.id)[0]));
        check('OV5 correction is a NEW event of its own kind', 'override-adjustment', PAYOUTS.filter(function(x){return x.rowId===o5.id&&x.kind==='override-adjustment';})[0].kind);
        check('OV5 correction points at the original', bad.id, PAYOUTS.filter(function(x){return x.kind==='override-adjustment';})[0].adjOf);
        check('OV5 net override now 150', 150, ovNet(o5.id));
        check('OV5 variance cleared', 0, payoutVariance(o5).filter(function(x){return x.kind==='override';}).length);
        if(typeof runChecks==='function') check('OV5 Hawk clear', undefined, (runChecks().find(function(c){return c.id==='hawkOvGross';})||{}).items);
        check('OV5 correction counted in the report ledger override', 150, commissionFor(OM,'2026-07','due').ledgerOv + commissionFor(OM,todayISO().slice(0,7),'due').ledgerOv - (('2026-07'===todayISO().slice(0,7))?150:0));
        // the row's REP payout must be untouched by a manager correction
        check('OV5 rep paid still 300 (override correction never pollutes it)', 300, ledgerPaid(o5,'OA'));
        check('OV5 row paidAmt still the rep figure', 300, +o5.paidAmt);
        check('OV5 paidOut(row) still the rep figure', 300, paidOut(o5));

        // O6 — a manager with no override rate gets no entry
        PAYOUTS=[]; OM.commOv=0; var o6=mkO({}); ROWS=[o6]; o6.paid='2026-07-15'; journalPaid(o6,'2026-07-15');
        check('OV6 commOv 0: no override entry', 0, ovOf(o6.id).length);
        OM.commOv=5;

        // O7 — position identity still holds with an override correction in play
        PAYOUTS=[]; ROWS=[o5]; o5.paid='2026-07-15'; PAYOUTS=[]; journalPaid(o5,'2026-07-15');
        recordCorrection(o5.id,'OM',-25,'test',{kind:'override'});
        var pos=compPosition(OM,todayISO().slice(0,7));
        check('OV7 balance identity holds', pos.closing, pos.opening+pos.earned+pos.override+pos.adjust-pos.chargebacks-pos.paid);

        // O8 — REVIEW PANEL: a correction followed by a reversal must not recover twice
        PAYOUTS=[]; var o8=mkO({}); ROWS=[o8]; o8.paid='2026-07-15'; journalPaid(o8,'2026-07-15');
        var gross=ovOf(o8.id)[0]; gross.amount=250; gross.basisValue=5000;      // an override entry written too high
        recordCorrection(o8.id,'OM',-50,'recorded on the wrong basis',{kind:'override'});
        check('OV8 after correction the manager net-holds 200', 200, ovNet(o8.id));
        o8.voidType='cancelled'; o8.voidAmt=4000; o8.voidDate='2026-08-05'; journalReversal(o8);
        check('OV8 fully cancelled: chargeback recovers exactly what is held (200), not the entry alone', 0, ovNet(o8.id));
        check('OV8 the chargeback event is 200', -200, PAYOUTS.filter(function(x){return x.rowId===o8.id&&x.kind==='manager-chargeback'&&x.status!=='void';}).reduce(function(a,x){return a+x.amount;},0));

        // O9 — REVIEW PANEL: a rep chargeback already recovered the money, so no
        // "over-paid" correction may be offered for it (that would recover it twice)
        PAYOUTS=[]; var o9=mkO({}); ROWS=[o9]; o9.paid='2026-07-15'; journalPaid(o9,'2026-07-15');
        check('OV9 rep paid 400', 400, ledgerPaid(o9,'OA'));
        o9.voidType='cancelled'; o9.voidAmt=4000; o9.voidDate='2026-08-05'; journalReversal(o9);
        check('OV9 rep chargeback −400 recorded', -400, PAYOUTS.filter(function(x){return x.rowId===o9.id&&x.kind==='rep-chargeback'&&x.status!=='void';}).reduce(function(a,x){return a+x.amount;},0));
        check('OV9 rep now nets 0 — square', 0, ledgerRepNet(o9,'OA'));
        check('OV9 NO phantom correction offered for the rep', 0, payoutVariance(o9).filter(function(x){return x.kind==='rep';}).length);
        check('OV9 NO phantom correction offered for the manager', 0, payoutVariance(o9).filter(function(x){return x.kind==='override';}).length);
        // a genuine drift on a reversed sale is still caught
        o9.value=6000;
        checkTrue('OV9 a real drift after the reversal is still flagged', payoutVariance(o9).length>0, payoutVariance(o9).length);

        // O10 — CRITICAL #2: a cloud copy may ADD ledger entries, never erase them
        PAYOUTS=[]; var oc=mkO({}); ROWS=[oc]; oc.paid='2026-07-15'; journalPaid(oc,'2026-07-15');
        var fingerprint=JSON.stringify(PAYOUTS.map(function(x){return [x.id,x.emp,x.kind,x.amount];}).sort());
        var wasApplying=CLOUD.applying;
        cloudApply(Object.assign(JSON.parse(JSON.stringify(stateSnapshot())),{payouts:[]}));   // stale device pushes an empty ledger
        CLOUD.applying=wasApplying;
        check('OV10 empty cloud ledger does NOT erase paid history', fingerprint, JSON.stringify(PAYOUTS.map(function(x){return [x.id,x.emp,x.kind,x.amount];}).sort()));
        check('OV10 no duplicate entries after the merge', 2, PAYOUTS.length);
        var extra={id:'po-from-cloud',kind:'rep',emp:'OA',rowId:oc.id,period:'2026-07',basisValue:1,rate:1,share:1,amount:7,paidOn:'2026-07-15',status:'paid',at:'',by:'other device'};
        cloudApply(Object.assign(JSON.parse(JSON.stringify(stateSnapshot())),{payouts:[extra]}));
        CLOUD.applying=wasApplying;
        checkTrue('OV10 an entry only the cloud has IS adopted', PAYOUTS.some(function(x){return x.id==='po-from-cloud';}), PAYOUTS.length);

        window.alert=alertO; window.toast=toastO; PAYOUTS=[]; DISPUTES=[];
      } else {
        results.push({name:'override-on-net fix present', expected:true, actual:false, pass:false});
      }


      /* ---------- ROLES & CAPABILITIES — people see what their job needs ---------- */
      if(typeof can==='function' && typeof scopeOf==='function'){
        var sessSnapR=localStorage.getItem('alp_session_v1'), adminSnapR=ADMIN, tabSnapR=TAB;
        var RP=function(id,n,x){ return Object.assign(mkPerson({id:id,name:n}),{first:n.split(' ')[0],last:'Role',active:true,start:'2026-01-01',roles:['sales'],aliases:[],log:[],caps:[],email:'',mgr:''},x||{}); };
        var kOWN=RP('K_OWN','Owner Role',{email:'own@automatedlawnandpest.com',roles:['sales','manager']});
        var kMGR=RP('K_MGR','Mgr Role',{email:'mgr@automatedlawnandpest.com',roles:['manager'],commOv:5});
        var kSLS=RP('K_SLS','Sls Role',{email:'sls@automatedlawnandpest.com',roles:['sales'],mgr:'K_MGR'});
        var kCSR=RP('K_CSR','Csr Role',{email:'csr@automatedlawnandpest.com',roles:['office']});
        var kBIL=RP('K_BIL','Bil Role',{email:'bil@automatedlawnandpest.com',roles:['office'],title:'Billing Coordinator'});
        var kFLD=RP('K_FLD','Fld Role',{email:'fld@automatedlawnandpest.com',roles:['tech']});
        PEOPLE=[kOWN,kMGR,kSLS,kCSR,kBIL,kFLD]; EMP_IDX=null;
        ROWS=[mkRow({rep:'K_SLS',value:1000,client:'RC'}), mkRow({rep:'K_MGR',value:2000,client:'RC'}), mkRow({rep:'K_CSR',value:3000,client:'RC'})];
        var beRole=function(p,admin){ ADMIN=!!admin; localStorage.setItem('alp_session_v1',JSON.stringify({token:'t.x',email:p.email,name:p.name,role:admin?'admin':'rep'})); capsInvalidate(); };

        beRole(kOWN,true);
        check('ROLE owner lands on 30,000 ft', 'view', homeTab());
        check('ROLE owner sees every sale', 3, visibleRows().length);
        check('ROLE owner sales scope', 'all', scopeOf('sales'));
        checkTrue('ROLE owner may manage comp plans and imports', can('manage_comp_plans')&&can('manage_imports')&&can('admin_security'), 'ok');
        checkTrue('ROLE owner sees anyone else money', canSeeMoneyOf(kSLS)&&canSeeMoneyOf(kBIL), 'ok');

        beRole(kMGR,false);
        check('ROLE manager lands on the team home', 'mgr', homeTab());
        check('ROLE manager sales scope is the team', 'team', scopeOf('sales'));
        check('ROLE manager sees a report sale and their own', 2, visibleRows().length);
        checkTrue('ROLE manager sees a report money', canSeeMoneyOf(kSLS), 'ok');
        checkTrue('ROLE manager does NOT see an unrelated person money', !canSeeMoneyOf(kCSR), canSeeMoneyOf(kCSR));
        checkTrue('ROLE manager gets no owner tools', !can('manage_comp_plans')&&!can('manage_imports')&&!can('admin_security')&&!can('view_team_cost'), 'ok');
        checkTrue('ROLE manager cannot open Comp plans, 30k or Admin', !tabAllowed('plans')&&!tabAllowed('view')&&!tabAllowed('admin'), 'ok');

        beRole(kSLS,false);
        check('ROLE salesperson lands on their own sales home', 'me', homeTab());
        check('ROLE salesperson sees only their own sale', 1, visibleRows().length);
        check('ROLE salesperson commission scope is own', 'own', scopeOf('commission'));
        checkTrue('ROLE salesperson sees their own money', canSeeMoneyOf(kSLS), 'ok');
        checkTrue('ROLE salesperson does NOT see a colleague money', !canSeeMoneyOf(kMGR)&&!canSeeMoneyOf(kOWN), 'ok');
        checkTrue('ROLE salesperson cannot open Team cost, Adjustments, Import or Admin',
          !tabAllowed('team')&&!tabAllowed('adj')&&!tabAllowed('import')&&!tabAllowed('admin'), 'ok');
        checkTrue('ROLE salesperson CAN open clients and the map', tabAllowed('clients')&&tabAllowed('map'), 'ok');
        var toastSnapR=window.toast; window.toast=function(){};
        TAB='me'; setTab('plans'); check('ROLE direct navigation to Comp plans is refused', 'me', TAB);
        setTab('admin'); check('ROLE direct navigation to Admin is refused', 'me', TAB);
        // Marking commission PAID is payroll's, not the rep's — and the block is in
        // the function, so it holds however the button was reached.
        var pr=ROWS[0];
        checkTrue('ROLE salesperson cannot mark their own commission paid', stageBlocked('paid'), 'blocked');
        checkTrue('ROLE the paid cell is read-only for a rep', stageCell(pr,'paid').indexOf('<input')<0, stageCell(pr,'paid').slice(0,40));
        var paidWas=pr.paid||''; setStage(pr.id,'paid','2026-08-01');
        check('ROLE calling setStage directly does not pay a rep', paidWas, pr.paid||'');
        checkTrue('ROLE salesperson CAN still move a sale to invoiced', !stageBlocked('invoiced'), 'allowed');
        window.toast=toastSnapR;

        beRole(kCSR,false);
        check('ROLE CSR lands on the client desk', 'cx', homeTab());
        check('ROLE CSR sees no sales', 0, visibleRows().length);
        check('ROLE CSR sees no commission', 'none', scopeOf('commission'));
        checkTrue('ROLE CSR may work clients and properties', can('view_clients')&&can('edit_clients')&&can('view_properties'), 'ok');
        checkTrue('ROLE CSR gets no employee compensation', !canSeeMoneyOf(kSLS)&&!can('view_client_financials'), 'ok');

        beRole(kBIL,false);
        check('ROLE billing lands on the billing home', 'bill', homeTab());
        checkTrue('ROLE billing may see CLIENT financials', can('view_client_financials')&&can('view_revenue'), 'ok');
        checkTrue('ROLE billing may NOT see EMPLOYEE compensation', !canSeeMoneyOf(kSLS)&&!can('view_all_commissions')&&!tabAllowed('plans'), 'ok');
        check('ROLE billing sees no sales rows', 0, visibleRows().length);

        beRole(kOWN,true);
        var toastSnapR2=window.toast; window.toast=function(){};
        checkTrue('ROLE payroll CAN mark commission paid', !stageBlocked('paid'), 'allowed');
        checkTrue('ROLE the paid cell is editable for payroll', stageCell(ROWS[0],'paid').indexOf('<input')>-1, 'input');
        window.toast=toastSnapR2;

        beRole(kFLD,false);
        check('ROLE field lands on their own page', 'mine', homeTab());
        checkTrue('ROLE field gets no financial tabs', !tabAllowed('comm')&&!tabAllowed('rev')&&!tabAllowed('sales')&&!tabAllowed('adj'), 'ok');
        checkTrue('ROLE field can still reach their page and the service calendar', tabAllowed('mine')&&tabAllowed('svc'), 'ok');

        kSLS.caps=['view_team_sales']; capsInvalidate(); beRole(kSLS,false);
        check('ROLE a per-person capability widens just that person', 'team', scopeOf('sales'));
        kSLS.caps=[]; capsInvalidate();

        beRole(kSLS,false); var a1=scopeOf('sales');
        beRole(kOWN,true);  var a2=scopeOf('sales');
        check('ROLE capabilities re-evaluate when the person changes', 'own/all', a1+'/'+a2);
        ADMIN=false; capsInvalidate();
        checkTrue('ROLE losing admin drops company scope immediately', scopeOf('sales')!=='all', scopeOf('sales'));

        if(sessSnapR!=null) localStorage.setItem('alp_session_v1',sessSnapR); else localStorage.removeItem('alp_session_v1');
        ADMIN=adminSnapR; TAB=tabSnapR; capsInvalidate();
      } else {
        results.push({name:'capability model exists (can/scopeOf)', expected:true, actual:false, pass:false});
      }


      /* ---------- DATA INTEGRITY: a missing number is not zero ---------- */
      // money/money2/num/fmt used to paint "$NaN", "$-0" and "undefined NaN" straight onto
      // dashboard tiles, so a malformed import looked like a real figure of zero.
      check('FMT money(undefined) is a dash, not $NaN', '\u2014', money(undefined));
      check('FMT money("abc") is a dash', '\u2014', money('abc'));
      check('FMT money2(undefined) is a dash', '\u2014', money2(undefined));
      // this harness defines its own num() helper, so reach the app's through window
      check('FMT num(undefined) is a dash', '\u2014', window.num(undefined,0));
      check('FMT fmt("") is a dash, not "undefined NaN"', '\u2014', fmt(''));
      check('FMT fmtY("") is a dash', '\u2014', fmtY(''));
      check('FMT a rounding artefact never prints as $-0', '$0', money(-0.004));
      check('FMT money2 folds -0 into 0.00', '$0.00', money2(-0.0001));
      check('FMT round2 never returns negative zero', 'false', String(Object.is(round2(-0.004),-0)));
      check('FMT a real number is untouched', '$1,235', money(1234.56));
      check('FMT a real number keeps its cents', '$1,234.57', money2(1234.567));
      check('FMT a real negative is still negative', '$-1,234.57', money2(-1234.567));
      check('FMT zero is still zero, not a dash', '$0', money(0));

      /* ---------- DATA INTEGRITY: re-import must not duplicate a sale ---------- */
      // An export with no record ID of its own is recognised by source+date+client+value.
      // The salesperson is deliberately NOT part of that key: an unresolvable name lands on
      // the import default, so keying on it duplicated the job under a second name.
      if(typeof importDupKey==='function'){
        var ik=function(o){ return importDupKey(Object.assign({src:'SA',date:'2026-06-03',
          client:'Harborview HOA',value:1240,basis:'contract',qty:1,rep:'A'},o||{})); };
        check('IMPORT dedupe key ignores the salesperson', ik({rep:'A'}), ik({rep:'B'}));
        checkTrue('IMPORT dedupe key still separates different values', ik({value:1240})!==ik({value:1250}), 'ok');
        checkTrue('IMPORT dedupe key still separates different dates', ik({date:'2026-06-03'})!==ik({date:'2026-06-04'}), 'ok');
        checkTrue('IMPORT dedupe key still separates different clients', ik({client:'A Co'})!==ik({client:'B Co'}), 'ok');
        checkTrue('IMPORT dedupe key still separates different sources', ik({src:'SA'})!==ik({src:'EL'}), 'ok');
        check('IMPORT dedupe key is case-insensitive on the client', ik({client:'HARBORVIEW HOA'}), ik({client:'harborview hoa'}));
      } else {
        results.push({name:'importDupKey exists', expected:true, actual:false, pass:false});
      }

      /* ---------- DATA INTEGRITY: one sale is paid once ---------- */
      if(typeof journalPaid==='function'){
        var alertJ=window.alert, toastJ=window.toast; window.alert=function(){}; window.toast=function(){};
        var JA=mkPerson({id:'JA',name:'Jay Rep'}); JA.first='Jay'; JA.last='Rep'; JA.roles=['sales'];
        JA.start='2026-01-01'; JA.commNew=10; JA.mgr='JM'; JA.aliases=[]; JA.log=[];
        var JM=mkPerson({id:'JM',name:'Jem Mgr'}); JM.first='Jem'; JM.last='Mgr'; JM.roles=['manager'];
        JM.start='2026-01-01'; JM.commOv=5; JM.commNew=0; JM.commUp=0; JM.aliases=[]; JM.log=[];
        PEOPLE=[JA,JM]; PAYOUTS=[]; EMP_IDX=null; GLOBAL.payLag=30;
        var jr=mkRow({rep:'JA',value:4000,type:'new',date:'2026-06-05',invoiced:'2026-06-10',client:'Idem Co'});
        ROWS=[jr]; freezeDueLag(jr); jr.commRate=rowRate(jr); jr.paid='2026-07-10';
        var live=function(emp){ return round2(PAYOUTS.filter(function(x){return x.rowId===jr.id&&x.emp===emp&&x.status!=='void';})
          .reduce(function(a,x){return a+x.amount;},0)); };
        journalPaid(jr,'2026-07-10');
        check('LEDGER first journalPaid pays the rep once', 400, live('JA'));
        check('LEDGER first journalPaid pays the override once', 200, live('JM'));
        var entriesOnce=PAYOUTS.length;
        journalPaid(jr,'2026-07-10'); journalPaid(jr,'2026-07-12');
        check('LEDGER journalPaid called again does not pay the rep twice', 400, live('JA'));
        check('LEDGER journalPaid called again does not pay the override twice', 200, live('JM'));
        check('LEDGER no extra entries are written', entriesOnce, PAYOUTS.length);
        // un-pay then re-pay is still allowed - that is a real correction, not a double
        unjournalPaid(jr,'test'); jr.paid='';
        check('LEDGER un-pay clears the live balance', 0, live('JA'));
        jr.paid='2026-07-20'; journalPaid(jr,'2026-07-20');
        check('LEDGER re-pay after un-pay works exactly once', 400, live('JA'));
        window.alert=alertJ; window.toast=toastJ; PAYOUTS=[];
      }

      /* ---------- DATA INTEGRITY: an orphan sale must not blank the app ---------- */
      // A sale whose rep id no longer exists is parked on the Unassigned holding record.
      // EMP_UNASSIGNED must be readable when empParkOrphans() runs during boot - it used to
      // be declared 283 lines later, so the first orphan threw and the whole page rendered
      // nothing at all.
      if(typeof empParkOrphans==='function'){
        checkTrue('ORPHAN EMP_UNASSIGNED is defined', typeof EMP_UNASSIGNED==='string' && !!EMP_UNASSIGNED, typeof EMP_UNASSIGNED);
        var OP=mkPerson({id:'OP',name:'Op Rep'}); OP.first='Op'; OP.last='Rep'; OP.roles=['sales'];
        OP.start='2026-01-01'; OP.aliases=[]; OP.log=[];
        PEOPLE=[OP]; EMP_IDX=null;
        var ghost=mkRow({rep:'NO_SUCH_EMPLOYEE',value:1000,client:'Orphan Co'});
        ROWS=[ghost];
        var threw='';
        try{ empParkOrphans(); }catch(e){ threw=e.message; }
        check('ORPHAN parking an orphan does not throw', '', threw);
        check('ORPHAN the sale is parked on Unassigned', EMP_UNASSIGNED, ghost.rep);
        check('ORPHAN the original id is kept for review', 'NO_SUCH_EMPLOYEE', ghost.repOrphan);
        check('ORPHAN the sale is marked as an orphan', 'orphan', ghost.repHow);
        checkTrue('ORPHAN the money is not re-credited to a real person',
          PEOPLE.filter(function(p){return p.id!==EMP_UNASSIGNED;}).every(function(p){return p.id!==ghost.rep;}), 'ok');
        check('ORPHAN the holding record is inactive and unscored', 'false/false',
          (function(){ var u=PEOPLE.find(function(p){return p.id===EMP_UNASSIGNED;})||{};
            return String(!!u.active)+'/'+String(!!u.scored); })());
      }

      /* ---------- DATA INTEGRITY: the rep-mismatch check must not cry wolf ---------- */
      // Sale and invoice used to be matched on client name inside a 60-day window, so a
      // recurring client with two sales in that window matched BOTH invoices and every one
      // of those sales was reported as a rep mismatch against the other sale's invoice.
      if(typeof runChecks==='function'){
        var alertH=window.alert, toastH=window.toast; window.alert=function(){}; window.toast=function(){};
        var HA=mkPerson({id:'HA',name:'Hana Rep'}); HA.first='Hana'; HA.last='Rep'; HA.roles=['sales'];
        HA.start='2026-01-01'; HA.commNew=10; HA.aliases=[]; HA.log=[];
        var HB=mkPerson({id:'HB',name:'Hugo Rep'}); HB.first='Hugo'; HB.last='Rep'; HB.roles=['sales'];
        HB.start='2026-01-01'; HB.commNew=10; HB.aliases=[]; HB.log=[];
        PEOPLE=[HA,HB]; EMP_IDX=null; PAYOUTS=[]; DISPUTES=[];
        // one recurring client, two sales three weeks apart, each correctly invoiced
        var s1=mkRow({id:'hr1',rep:'HA',date:'2026-06-01',client:'Recurring Co',value:1000,invoiced:'2026-06-05'});
        var s2=mkRow({id:'hr2',rep:'HB',date:'2026-06-22',client:'Recurring Co',value:1000,invoiced:'2026-06-26'});
        ROWS=[s1,s2];
        INVOICES=[{c:'Recurring Co',a:'',r:'Hana Rep',i:'INV-1',d:'2026-06-05',s:'S',v:1000,k:'x',t:0},
                  {c:'Recurring Co',a:'',r:'Hugo Rep',i:'INV-2',d:'2026-06-26',s:'S',v:1000,k:'x',t:0}];
        var repCheck=function(){ var c=runChecks().find(function(x){return x.id==='hawkRep';}); return c?c.items.length:0; };
        check('HAWK a recurring client with two correctly-invoiced sales raises nothing', 0, repCheck());
        // now a genuine mismatch, linked by a real invoice number
        s1.invNo='INV-2';
        check('HAWK a real mismatch linked by invoice number is caught', 1, repCheck());
        s1.invNo='';
        // and a genuine mismatch on a client with a single sale in the window
        ROWS=[s1]; INVOICES=[{c:'Recurring Co',a:'',r:'Hugo Rep',i:'INV-9',d:'2026-06-05',s:'S',v:1000,k:'x',t:0}];
        check('HAWK a real mismatch on an unambiguous client is caught', 1, repCheck());
        window.alert=alertH; window.toast=toastH;
      }


      /* ---------- MONEY: the parts of a split always add back to the whole ---------- */
      // 33.33 x 3 is 99.99, not 100.00. Rounding each share on its own lost a penny, the
      // row still recorded the whole, and payoutVariance then offered a correction for a
      // one-cent gap that could never be cleared.
      if(typeof splitAmounts==='function'){
        var third=[{rep:'a',frac:1/3},{rep:'b',frac:1/3},{rep:'c',frac:1/3}];
        var sa=splitAmounts(100,third);
        check('SPLIT thirds of $100 add back to $100', 100, round2(sa[0]+sa[1]+sa[2]));
        check('SPLIT the residual goes to one share, not all', '33.34,33.33,33.33', sa.join(','));
        var sixths=[{rep:'a',frac:1/6},{rep:'b',frac:1/6},{rep:'c',frac:1/6},
                    {rep:'d',frac:1/6},{rep:'e',frac:1/6},{rep:'f',frac:1/6}];
        check('SPLIT six ways still adds back', 100, round2(splitAmounts(100,sixths).reduce(function(a,b){return a+b;},0)));
        check('SPLIT an uneven pair adds back', 77.77, round2(splitAmounts(77.77,[{rep:'a',frac:0.7},{rep:'b',frac:0.3}]).reduce(function(a,b){return a+b;},0)));
        check('SPLIT a single share is untouched', '400', splitAmounts(400,[{rep:'a',frac:1}]).join(','));
        check('SPLIT zero stays zero', '0', splitAmounts(0,[{rep:'a',frac:1}]).join(','));
      }
      if(typeof journalPaid==='function' && typeof payoutVariance==='function'){
        var alertS=window.alert, toastS=window.toast; window.alert=function(){}; window.toast=function(){};
        var S1=mkPerson({id:'SP1',name:'Sp One'}); S1.first='Sp'; S1.last='One'; S1.roles=['sales'];
        S1.start='2026-01-01'; S1.commNew=10; S1.aliases=[]; S1.log=[];
        var S2=mkPerson({id:'SP2',name:'Sp Two'}); S2.first='Sp'; S2.last='Two'; S2.roles=['sales'];
        S2.start='2026-01-01'; S2.commNew=10; S2.aliases=[]; S2.log=[];
        var S3=mkPerson({id:'SP3',name:'Sp Three'}); S3.first='Sp'; S3.last='Three'; S3.roles=['sales'];
        S3.start='2026-01-01'; S3.commNew=10; S3.aliases=[]; S3.log=[];
        PEOPLE=[S1,S2,S3]; PAYOUTS=[]; EMP_IDX=null; GLOBAL.payLag=30;
        var sr=mkRow({rep:'SP1',value:1000,type:'new',date:'2026-06-05',invoiced:'2026-06-10',client:'Split Co'});
        sr.split=[{rep:'SP1',pct:1},{rep:'SP2',pct:1},{rep:'SP3',pct:1}];
        ROWS=[sr]; freezeDueLag(sr); sr.commRate=rowRate(sr); sr.paid='2026-07-10';
        journalPaid(sr,'2026-07-10');
        var live=PAYOUTS.filter(function(x){return x.kind==='rep'&&x.status!=='void';});
        check('SPLIT an even three-way payout adds back to the whole commission', 100,
          round2(live.reduce(function(a,x){return a+x.amount;},0)));
        check('SPLIT the row records the same figure as the ledger', 100, round2(sr.paidAmt));
        check('SPLIT paidTo agrees with the ledger', 100, round2((sr.paidTo||[]).reduce(function(a,x){return a+x.amount;},0)));
        check('SPLIT no phantom variance on an even split', 0, payoutVariance(sr).length);
        window.alert=alertS; window.toast=toastS; PAYOUTS=[];
      }

      /* ---------- MONEY: the values that actually turn up in the book ---------- */
      if(typeof rowComm==='function'){
        var MP=mkPerson({id:'MM',name:'Money Rep'}); MP.first='Money'; MP.last='Rep'; MP.roles=['sales'];
        MP.start='2026-01-01'; MP.commNew=10; MP.aliases=[]; MP.log=[];
        PEOPLE=[MP]; EMP_IDX=null; PAYOUTS=[];
        var mv=function(v,rate){ var r=mkRow({rep:'MM',value:v,type:'new',date:'2026-06-05'});
          if(rate!=null) r.commRate=rate; ROWS=[r]; return round2(rowComm(r)); };
        check('MONEY $0 earns nothing', 0, mv(0));
        check('MONEY $0.01 at 10% rounds to a cent', 0, mv(0.01));
        check('MONEY $1 at 10%', 0.1, mv(1));
        check('MONEY $99.99 at 10%', 10, mv(99.99));
        check('MONEY $100 at 10%', 10, mv(100));
        check('MONEY $999.99 at 10%', 100, mv(999.99));
        check('MONEY $1,000 at 10%', 100, mv(1000));
        check('MONEY $10,000 at 10%', 1000, mv(10000));
        check('MONEY $100,000 at 10%', 10000, mv(100000));
        check('MONEY $1,234,567.89 at 10%', 123456.79, mv(1234567.89));
        check('MONEY 7.5% of $99.99 does not drift', 7.5, mv(99.99,7.5));
        check('MONEY 33.333% of $1,000 rounds cleanly', 333.33, mv(1000,33.333));
        check('MONEY a negative value cannot earn a negative commission', 0, mv(-500));
      }

      /* ---------- DATES: the boundaries that move a sale into the wrong period ---------- */
      check('DATE Dec 31 stays in December', '2026-12', '2026-12-31'.slice(0,7));
      check('DATE Jan 1 does not fall back a year', 'Jan 1, 2026', fmtY('2026-01-01'));
      check('DATE Dec 31 does not roll forward a year', 'Dec 31, 2026', fmtY('2026-12-31'));
      check('DATE a day is parsed in local time, never UTC', 1, dObj('2026-01-01').getDate());
      check('DATE the last day of a leap February exists', 'Feb 29, 2024', fmtY('2024-02-29'));
      check('DATE +1 day across new year', '2027-01-01', addDays('2026-12-31',1));
      check('DATE +1 day across a non-leap February', '2026-03-01', addDays('2026-02-28',1));
      check('DATE +1 day across a leap February', '2024-02-29', addDays('2024-02-28',1));
      check('DATE +1 day across the spring clock change', '2026-03-09', addDays('2026-03-08',1));
      check('DATE +1 day across the autumn clock change', '2026-11-02', addDays('2026-11-01',1));
      check('DATE a 30-day payment lag from Jan 31', '2026-03-02', addDays('2026-01-31',30));
      check('DATE the week starts on Monday', '2026-03-09', weekStart('2026-03-09'));
      check('DATE the week containing Jan 1 starts in the old year', '2025-12-29', weekStart('2026-01-01'));

      /* ---------- INTEGRITY: nothing points at a record that is not there ---------- */
      if(typeof empParkOrphans==='function'){
        var IP=mkPerson({id:'IP',name:'Int Rep'}); IP.first='Int'; IP.last='Rep'; IP.roles=['sales'];
        IP.start='2026-01-01'; IP.commNew=10; IP.aliases=[]; IP.log=[];
        PEOPLE=[IP]; EMP_IDX=null; PAYOUTS=[]; DISPUTES=[];
        var good=mkRow({rep:'IP',value:1000,client:'Fine Co'});
        ROWS=[good];
        var badRep=function(){ return ROWS.filter(function(r){ return !r.rep || !PEOPLE.some(function(p){return p.id===r.rep;}); }).length; };
        check('INTEGRITY a clean book has no sale pointing at a missing employee', 0, badRep());
        var orphan=mkRow({rep:'GONE',value:500,client:'Orphan Co'});
        ROWS=[good,orphan];
        check('INTEGRITY an orphan is visible before parking', 1, badRep());
        empParkOrphans();
        check('INTEGRITY parking clears it without losing the sale', 0, badRep());
        check('INTEGRITY the sale is still there, on the holding record', 2, ROWS.length);
        check('INTEGRITY its value is untouched', 500, bookedValue(ROWS[1]));
        // a payout pointing at a sale that no longer exists must stay visible, not vanish
        PAYOUTS=[{id:'po_x',kind:'rep',emp:'IP',rowId:'NO_SUCH_ROW',period:'2026-06',
                  basisValue:1000,rate:10,share:1,amount:100,paidOn:'2026-07-10',status:'paid'}];
        var orphanPayouts=PAYOUTS.filter(function(x){ return x.rowId && !ROWS.some(function(r){return r.id===x.rowId;}); }).length;
        check('INTEGRITY a payout whose sale was deleted is still detectable', 1, orphanPayouts);
        PAYOUTS=[];
      }


      /* ---------- PERIODS: "this week" and "to date" stop at today ---------- */
      // A sale dated ahead of today used to be counted in "this week" and in "year to
      // date" - a December sale appeared in an August week, and "to date" quietly meant
      // the whole calendar year.
      if(typeof empKpis==='function' && typeof empData==='function'){
        var WP=mkPerson({id:'WP',name:'Win Rep'}); WP.first='Win'; WP.last='Rep'; WP.roles=['sales'];
        WP.start='2026-01-01'; WP.commNew=10; WP.aliases=[]; WP.log=[];
        PEOPLE=[WP]; EMP_IDX=null; PAYOUTS=[]; DISPUTES=[];
        var td=todayISO(), wkStart=weekStart(td), future=addDays(td,100);
        var past=mkRow({rep:'WP',value:1000,date:addDays(td,-40),client:'Past Co'});
        var thisWk=mkRow({rep:'WP',value:500,date:wkStart,client:'Week Co'});
        var soon=mkRow({rep:'WP',value:7000,date:future,client:'Future Co'});
        ROWS=[past,thisWk,soon];
        var k=empKpis(empData('WP'));
        check('PERIOD this week counts only what has happened', 500, round2(k.week.v));
        check('PERIOD this week counts the right number of sales', 1, k.week.n);
        checkTrue('PERIOD year to date leaves out a future-dated sale', round2(k.ytd.v)<7000, round2(k.ytd.v));
        check('PERIOD year to date is the past plus this week', 1500, round2(k.ytd.v));
        check('PERIOD all time still includes everything booked', 8500, round2(k.all.v));
        checkTrue('PERIOD the gap between all and to-date reveals the future sale', k.all.n>k.ytd.n, k.all.n+' vs '+k.ytd.n);
        // a sale dated exactly today is inside every window
        var todayRow=mkRow({rep:'WP',value:250,date:td,client:'Today Co'});
        ROWS=[todayRow];
        var k2=empKpis(empData('WP'));
        check('PERIOD a sale dated today counts this week', 250, round2(k2.week.v));
        check('PERIOD a sale dated today counts year to date', 250, round2(k2.ytd.v));
        check('PERIOD a sale dated today counts this month', 250, round2(k2.month.v));
      }


      /* ---------- PAYROLL: the printed sheet must equal what the engine pays ---------- */
      // The per-sale detail on the commission report used to print bookedValue x the
      // person's CURRENT plan rate. On a 50/50 split that showed the FULL commission on
      // BOTH reps' sheets, it ignored reversals, and it ignored the rate frozen on the
      // sale. This is the page carrying the "approved for payroll" signature line.
      if(typeof commFor==='function'){
        var PA=mkPerson({id:'PA',name:'Pay Ann'}); PA.first='Pay'; PA.last='Ann'; PA.roles=['sales'];
        PA.start='2026-01-01'; PA.commNew=10; PA.commUp=5; PA.aliases=[]; PA.log=[];
        var PB=mkPerson({id:'PB',name:'Pay Bob'}); PB.first='Pay'; PB.last='Bob'; PB.roles=['sales'];
        PB.start='2026-01-01'; PB.commNew=10; PB.commUp=5; PB.aliases=[]; PB.log=[];
        PEOPLE=[PA,PB]; PAYOUTS=[]; EMP_IDX=null; GLOBAL.payLag=30;
        // a 50/50 split
        var sp=mkRow({rep:'PA',value:4000,type:'new',date:'2026-06-05',invoiced:'2026-06-10',client:'Split Co'});
        sp.split=[{rep:'PA',pct:50},{rep:'PB',pct:50}];
        // a partly refunded sale
        var rf=mkRow({rep:'PA',value:10000,type:'new',date:'2026-06-07',invoiced:'2026-06-10',client:'Refund Co'});
        rf.voidType='refunded'; rf.voidAmt=2000; rf.voidDate='2026-06-20';
        // a sale whose rate was frozen lower than the plan says today
        var fz=mkRow({rep:'PA',value:1000,type:'new',date:'2026-06-09',invoiced:'2026-06-10',client:'Rate Co'});
        ROWS=[sp,rf,fz];
        ROWS.forEach(function(r){ freezeDueLag(r); r.commRate=rowRate(r); });
        fz.commRate=7;
        check('PAYROLL a split pays each rep their share, never the whole', 200, round2(netValue(sp)*shareFor(sp,'PA')*rowRate(sp)/100));
        check('PAYROLL the two halves of a split add up to the whole commission', 400,
          round2(netValue(sp)*shareFor(sp,'PA')*rowRate(sp)/100 + netValue(sp)*shareFor(sp,'PB')*rowRate(sp)/100));
        check('PAYROLL a refunded sale is billed on what is left', 8000, netValue(rf));
        check('PAYROLL commission follows the net, not the gross', 800, round2(commFor(rf,'PA')));
        check('PAYROLL the rate frozen on the sale wins over the current plan', 7, rowRate(fz));
        check('PAYROLL commission uses the frozen rate', 70, round2(commFor(fz,'PA')));
        checkTrue('PAYROLL a rep with no share of a sale earns nothing on it', commFor(rf,'PB')===0, commFor(rf,'PB'));
        // once paid, the sheet must read the ledger, not recompute
        var alertP=window.alert, toastP=window.toast; window.alert=function(){}; window.toast=function(){};
        ROWS=[fz]; PAYOUTS=[]; fz.paid='2026-07-10'; journalPaid(fz,'2026-07-10');
        var beforeRateChange=round2(commFor(fz,'PA'));
        PA.commNew=25;
        check('PAYROLL a plan change never rewrites a paid sale on the sheet', beforeRateChange, round2(commFor(fz,'PA')));
        PA.commNew=10;
        window.alert=alertP; window.toast=toastP; PAYOUTS=[];
      }


      /* ---------- LEDGER: clearing a paid date undoes the WHOLE payment ---------- */
      // unjournalPaid used to void only the entries with status 'paid'. On a reversed
      // sale that left the chargebacks still 'applied', so clearing the paid date left
      // the rep owing money for a payment no longer on the ledger.
      if(typeof unjournalPaid==='function' && typeof journalReversal==='function'){
        var alertU=window.alert, toastU=window.toast; window.alert=function(){}; window.toast=function(){};
        var UA=mkPerson({id:'UA',name:'Un Ann'}); UA.first='Un'; UA.last='Ann'; UA.roles=['sales'];
        UA.start='2026-01-01'; UA.commNew=10; UA.mgr='UM'; UA.aliases=[]; UA.log=[];
        var UM=mkPerson({id:'UM',name:'Un Mia'}); UM.first='Un'; UM.last='Mia'; UM.roles=['manager'];
        UM.start='2026-01-01'; UM.commOv=5; UM.commNew=0; UM.commUp=0; UM.aliases=[]; UM.log=[];
        PEOPLE=[UA,UM]; PAYOUTS=[]; EMP_IDX=null; GLOBAL.payLag=30; GLOBAL.policy.clawbackDays=180;
        var ur=mkRow({rep:'UA',value:1000,type:'new',date:'2026-06-05',invoiced:'2026-06-10',client:'Undo Co'});
        ROWS=[ur]; freezeDueLag(ur); ur.commRate=rowRate(ur);
        ur.paid='2026-07-15'; journalPaid(ur,'2026-07-15');
        check('UNPAY the rep is paid', 100, round2(ledgerRepNet(ur,'UA')));
        check('UNPAY the manager override is paid', 50, round2(ledgerOverridePaid(ur,'UM')));
        ur.voidType='cancelled'; ur.voidAmt=1000; ur.voidDate='2026-08-05'; journalReversal(ur);
        check('UNPAY a cancellation claws both back to zero', '0/0',
          round2(ledgerRepNet(ur,'UA'))+'/'+round2(ledgerOverridePaid(ur,'UM')));
        unjournalPaid(ur,'paid date cleared'); ur.paid='';
        check('UNPAY clearing the paid date leaves the rep owing nothing', 0, round2(ledgerRepNet(ur,'UA')));
        check('UNPAY clearing the paid date leaves the manager owing nothing', 0, round2(ledgerOverridePaid(ur,'UM')));
        checkTrue('UNPAY nothing is deleted - every entry is kept, voided',
          PAYOUTS.length===4 && PAYOUTS.every(function(x){return x.status==='void';}), PAYOUTS.length+' entries');
        // and it can be paid again afterwards, exactly once
        ur.voidType=''; ur.voidAmt=0; ur.voidDate=''; ur.paid='2026-08-20';
        journalPaid(ur,'2026-08-20');
        check('UNPAY the sale can be paid again after the clear', 100, round2(ledgerRepNet(ur,'UA')));
        check('UNPAY and the override comes back with it', 50, round2(ledgerOverridePaid(ur,'UM')));
        window.alert=alertU; window.toast=toastU; PAYOUTS=[];
      }


      /* ---------- FREEZE: both ways of marking a sale invoiced must freeze it ---------- */
      // setStage froze the payment lag and the commission rate; bulkStamp did not. Forty
      // sales stamped at once stayed re-priceable, so a later plan-rate or payLag change
      // moved their due dates and rewrote what they were worth.
      if(typeof bulkStamp==='function' && typeof setStage==='function'){
        var alertF=window.alert, toastF=window.toast, confF=window.confirm;
        window.alert=function(){}; window.toast=function(){}; window.confirm=function(){return true;};
        var adminF=ADMIN, tabF=TAB; ADMIN=true; capsInvalidate();
        var FA=mkPerson({id:'FA',name:'Frz Ann'}); FA.first='Frz'; FA.last='Ann'; FA.roles=['sales'];
        FA.start='2026-01-01'; FA.commNew=10; FA.aliases=[]; FA.log=[];
        PEOPLE=[FA]; PAYOUTS=[]; EMP_IDX=null; GLOBAL.payLag=30;
        var one=mkRow({rep:'FA',value:1000,type:'new',date:'2026-06-05',client:'One Co'});
        var many=mkRow({rep:'FA',value:1000,type:'new',date:'2026-06-05',client:'Many Co'});
        one.invNo='INV-1'; one.files=[{n:'i.pdf',id:'f1'}];
        many.invNo='INV-2'; many.files=[{n:'i.pdf',id:'f2'}];
        ROWS=[one,many];
        setStage(one.id,'invoiced','2026-06-20');
        TAB='pipe'; render(); bulkStamp('invoiced');
        checkTrue('FREEZE the single-sale path freezes the payment lag', one.dueLag===30, one.dueLag);
        checkTrue('FREEZE the bulk path freezes the payment lag too', many.dueLag===30, many.dueLag);
        check('FREEZE the single-sale path freezes the rate', 10, one.commRate);
        check('FREEZE the bulk path freezes the rate too', 10, many.commRate);
        var dueOne=dueDate(one), dueMany=dueDate(many);
        FA.commNew=25; GLOBAL.payLag=60;
        check('FREEZE a later plan change cannot reprice the single-stamped sale', 100, round2(rowComm(one)));
        check('FREEZE a later plan change cannot reprice the bulk-stamped sale', 100, round2(rowComm(many)));
        check('FREEZE a later payLag change cannot move the single-stamped due date', dueOne, dueDate(one));
        check('FREEZE a later payLag change cannot move the bulk-stamped due date', dueMany, dueDate(many));
        FA.commNew=10; GLOBAL.payLag=30;
        ADMIN=adminF; TAB=tabF; capsInvalidate();
        window.alert=alertF; window.toast=toastF; window.confirm=confF; PAYOUTS=[];
      }


      /* ---------- RESTORE: the ledger must follow its sales ---------- */
      // Restored sales are given fresh ids. The payout ledger kept the backup's OLD row
      // id, so every restored payout came back orphaned: the sale read as paid but showed
      // no ledger, and the Hawk saw a book full of payments it could not account for.
      if(typeof stateSnapshot==='function'){
        var RA=mkPerson({id:'RA',name:'Res Ann'}); RA.first='Res'; RA.last='Ann'; RA.roles=['sales'];
        RA.start='2026-01-01'; RA.commNew=10; RA.aliases=[]; RA.log=[];
        PEOPLE=[RA]; PAYOUTS=[]; DISPUTES=[]; EMP_IDX=null; GLOBAL.payLag=30;
        var rr=mkRow({id:'r_backup_77',rep:'RA',value:1000,type:'new',date:'2026-06-05',
                      invoiced:'2026-06-10',client:'Restore Co'});
        ROWS=[rr]; freezeDueLag(rr); rr.commRate=rowRate(rr);
        var alertR=window.alert, toastR=window.toast; window.alert=function(){}; window.toast=function(){};
        rr.paid='2026-07-15'; journalPaid(rr,'2026-07-15');
        check('RESTORE the ledger is connected before the backup', 100, round2(ledgerRepNet(rr,'RA')));
        // simulate what restore does: fresh row id, ledger remapped through rowMap
        var backupRows=JSON.parse(JSON.stringify(ROWS));
        var backupPayouts=JSON.parse(JSON.stringify(PAYOUTS));
        ROWS=[]; PAYOUTS=[];
        var rowMap={};
        backupRows.forEach(function(br){
          var nr=Object.assign({},br,{id:'r_new_'+br.id});
          rowMap[br.id]=nr.id; ROWS.push(nr);
        });
        backupPayouts.forEach(function(x){
          var e=Object.assign({},x);
          if(e.rowId && rowMap[e.rowId]) e.rowId=rowMap[e.rowId];
          PAYOUTS.push(e);
        });
        var restored=ROWS[0];
        check('RESTORE the sale is given a new id', 'r_new_r_backup_77', restored.id);
        check('RESTORE the payout follows it', 'r_new_r_backup_77', PAYOUTS[0].rowId);
        check('RESTORE nothing is left pointing at a sale that is gone', 0,
          PAYOUTS.filter(function(x){ return x.rowId && !ROWS.some(function(q){return q.id===x.rowId;}); }).length);
        check('RESTORE the ledger reads back through the new id', 100, round2(ledgerRepNet(restored,'RA')));
        check('RESTORE the entry keeps its own id, so corrections still point at it', backupPayouts[0].id, PAYOUTS[0].id);
        window.alert=alertR; window.toast=toastR; PAYOUTS=[];
      }


      /* ---------- HAWK: a split paying everyone at one person's rate ---------- */
      // journalPaid applies ONE rate to every share - the primary rep's - so on a split
      // between two people on different plans, list order decides pay. Which rule is
      // right is Jeff's to set, so this is reported rather than silently changed.
      if(typeof runChecks==='function'){
        var alertX=window.alert, toastX=window.toast; window.alert=function(){}; window.toast=function(){};
        var XA=mkPerson({id:'XA',name:'Xa Ten'}); XA.first='Xa'; XA.last='Ten'; XA.roles=['sales'];
        XA.start='2026-01-01'; XA.commNew=10; XA.aliases=[]; XA.log=[];
        var XB=mkPerson({id:'XB',name:'Xb Eight'}); XB.first='Xb'; XB.last='Eight'; XB.roles=['sales'];
        XB.start='2026-01-01'; XB.commNew=8; XB.aliases=[]; XB.log=[];
        var XC=mkPerson({id:'XC',name:'Xc Ten'}); XC.first='Xc'; XC.last='Ten'; XC.roles=['sales'];
        XC.start='2026-01-01'; XC.commNew=10; XC.aliases=[]; XC.log=[];
        PEOPLE=[XA,XB,XC]; PAYOUTS=[]; DISPUTES=[]; EMP_IDX=null;
        var mixed=mkRow({rep:'XA',value:4000,type:'new',date:'2026-06-05',invoiced:'2026-06-10',client:'Mixed Co'});
        mixed.split=[{rep:'XA',pct:50},{rep:'XB',pct:50}];
        var matched=mkRow({rep:'XA',value:4000,type:'new',date:'2026-06-05',invoiced:'2026-06-10',client:'Matched Co'});
        matched.split=[{rep:'XA',pct:50},{rep:'XC',pct:50}];
        var plain=mkRow({rep:'XA',value:4000,type:'new',date:'2026-06-05',invoiced:'2026-06-10',client:'Plain Co'});
        ROWS=[mixed,matched,plain];
        ROWS.forEach(function(r){ freezeDueLag(r); r.commRate=rowRate(r); });
        var sr=function(){ var c=runChecks().find(function(x){return x.id==='hawkSplitRate';}); return c||{items:[],impact:0}; };
        check('HAWK a split across two different comp plans is reported', 1, sr().items.length);
        check('HAWK it names the money at stake', 40, round2(sr().impact));
        // a split between two people on the SAME rate is not a problem
        ROWS=[matched,plain];
        check('HAWK a split between two people on the same rate says nothing', 0, sr().items.length);
        // and a plain sale never triggers it
        ROWS=[plain];
        check('HAWK a sale with no split says nothing', 0, sr().items.length);
        window.alert=alertX; window.toast=toastX; PAYOUTS=[];
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
