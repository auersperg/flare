import {
  CloudflareAccount,
  cloudflareToken,
} from "../../packages/flare/src/cli/cloudflare-account.mjs";
import { InstallationStore } from "../../packages/flare/src/cli/platform-state.mjs";

/** Explicit operator proof context. No macOS OAuth parsing, secret import or
 * private legacy resource descriptor. Individual fixtures still own cleanup. */
export async function loadCloudFixture() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-f0-9]{32}$/.test(accountId ?? ""))
    throw Error("Cloud proof requires explicit CLOUDFLARE_ACCOUNT_ID");
  const oauth = await cloudflareToken();
  const cloud = new CloudflareAccount(accountId, oauth);
  const { state } = await new InstallationStore(cloud, "default").discover();
  // These historical harnesses contain fixed operator-layout service bindings.
  // Refuse a different managed layout instead of guessing names or touching it.
  if (!state?.installed || state.operation || state.origin !== "operator")
    throw Error(
      "This cloud fixture requires an idle adopted default operator installation",
    );
  return {
    cloud,
    oauth,
    account: `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
    install: {
      owner: state.owner,
      devTokenIssuer: `https://${state.addresses.runtimeHost}`,
      account: accountId,
      database: state.resources.catalog.id,
      runtimeUrl: `https://${state.addresses.runtimeHost}`,
      dashboardUrl: `https://${state.addresses.adminHost}`,
    },
  };
}
