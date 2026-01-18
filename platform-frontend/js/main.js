(function () {
  console.log("Wasit platform loaded");

  const envEl = document.getElementById("env");
  if (envEl) {
    envEl.textContent = `Loaded at ${new Date().toISOString()}`;
  }
})();
