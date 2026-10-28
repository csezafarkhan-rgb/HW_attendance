(function(){
  'use strict';
  if (!parent.HWMobile) return;
  parent.HWMobile.installFetch(window);
  window.HWAuth = {onExpired:function(){parent.HWAuth && parent.HWAuth.onExpired();}};
  window.__browserPrint = window.print.bind(window);
  window.print = function(){parent.HWMobile.printDocument(window);};
})();
