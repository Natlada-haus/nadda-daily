(function () {
  var ORIGIN = "https://daily.natlada.com";
  var PREFIX = "/nadda-daily";

  function mappedPath(pathname) {
    var path = pathname || "/";
    if (path === PREFIX || path.indexOf(PREFIX + "/") === 0) path = path.slice(PREFIX.length) || "/";
    if (!path || path.charAt(0) !== "/") path = "/" + path;
    return path;
  }

  function targetUrl(loc) {
    return ORIGIN + mappedPath(loc.pathname) + (loc.search || "") + (loc.hash || "");
  }

  var host = location.hostname || "";
  var onPages = host === "github.io" || host.slice(-10) === ".github.io";
  var path = onPages ? mappedPath(location.pathname) : (location.pathname || "/");
  if (!path || path.charAt(0) !== "/") path = "/" + path;
  var link = document.querySelector('link[rel="canonical"]');
  if (link) link.setAttribute("href", ORIGIN + path + (location.search || ""));
  if (onPages) location.replace(targetUrl(location));
})();
