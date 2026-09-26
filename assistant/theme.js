// Applies the owner's Light / Dark choice before the first paint (a classic
// script in <head>, so there is no flash of the other theme). "System" —
// the default — leaves it to the device.
(function () {
  var t = null;
  try { t = localStorage.getItem('asst:theme'); } catch (e) { /* storage blocked */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
