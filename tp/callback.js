/* Normally the phone opens the app straight from this link (an app link) and this page is never seen. If it is seen, pass the sign-in result to the app's own scheme. */
(function(){var q=location.search,o=document.getElementById("o");o.href="app.tidepocket://auth"+q;setTimeout(function(){location.href=o.href},400)})()
