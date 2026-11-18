try{var a=JSON.parse(localStorage.getItem("pw.saved")||"[]"),s=document.getElementById("s");a.slice(0,8).forEach(function(i){var l=document.createElement("a");l.href=i.p;l.textContent=(i.t||"").replace(/^Tide times at /,"");s.appendChild(l)})}catch(e){}
document.getElementById("r").addEventListener("click",function(){location.reload()});
