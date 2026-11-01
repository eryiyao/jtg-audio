'use strict';
window.JtgSession = (() => {
  let leaving = false;
  return {
    async request(url, options = {}) {
      const headers = new Headers(options.headers);
      if (!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) headers.set('X-JTG-Request', '1');
      const response = await fetch(url, { ...options, headers });
      if (response.status === 401 && !leaving) {
        leaving = true;
        window.dispatchEvent(new Event('jtg:session-expired'));
        location.replace('/login?expired=1');
      }
      return response;
    },
  };
})();
