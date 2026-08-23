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
               HOURS:(typeof HOURS!=='undefined'?HOURS:undefined),
               TOMBSTONES:(typeof TOMBSTONES!=='undefined'?TOMBSTONES:undefined) };
    try{
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

      /* ---------- DATA HAWK: cross-CRM double-count caught despite differences ---------- */
      // different spelling, $50 apart, 10 days apart — the naive exact-match missed all of this
      ROWS=[ mkRow({type:'upsell', value:12500, client:'Test Customer A', src:'EL', date:'2026-06-05'}),
             mkRow({type:'upsell', value:12450, client:'Test Cust A',    src:'SA', date:'2026-06-15'}) ];
      var crossChk=(typeof runChecks==='function')?runChecks().find(function(c){return c.id==='cross';}):null;
      checkTrue('HAWK catches fuzzy cross-CRM double (spelling+$50+10d)',
        crossChk && crossChk.items.length>=1, crossChk?crossChk.items.length:'no check');

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
      if(typeof HOURS!=='undefined' && snap.HOURS!==undefined) HOURS=snap.HOURS;
      if(typeof TOMBSTONES!=='undefined' && snap.TOMBSTONES!==undefined) TOMBSTONES=snap.TOMBSTONES;
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
