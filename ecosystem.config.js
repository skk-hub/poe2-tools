// pm2 config for the headless Path of Building agent (Gear Finder split-host setup).
// Run on the MAIN PC — where Path of Building + LuaJIT are installed:
//
//   pm2 start ecosystem.config.js && pm2 save
//
// Then on the VM set POB_BRIDGE_URL=http://<this-pc-lan-or-tailscale-ip>:17778 so
// the VM-hosted app forwards build/calc requests here. If you already keep a pm2
// ecosystem file, just copy the app block below into it instead.
//
// The agent runs PoB on whatever build XML it's sent — keep it LAN/Tailscale-only,
// never port-forwarded to the internet.
module.exports = {
  apps: [
    {
      name: "pob-agent",
      script: "pob-agent.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      env: {
        // Force LOCAL mode: the agent must spawn PoB itself, never proxy to itself
        // (blanks any global POB_BRIDGE_URL you may have set for the VM side).
        POB_BRIDGE_URL: "",
        // Defaults below are optional — uncomment to override:
        // POB_AGENT_PORT: "17778",
        // POB_LUAJIT: "C:\\Users\\User\\AppData\\Local\\Programs\\LuaJIT\\bin\\luajit.exe",
        // POB_DIR: "C:\\Users\\User\\AppData\\Roaming\\Path of Building Community (PoE2)",
      },
    },
  ],
};
