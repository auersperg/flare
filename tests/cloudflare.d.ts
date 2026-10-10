declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../packages/core/src/runtime") &
      typeof import("./kernel/kernel");
    durableNamespaces: "AppSupervisor";
  }
}
