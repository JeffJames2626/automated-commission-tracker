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
