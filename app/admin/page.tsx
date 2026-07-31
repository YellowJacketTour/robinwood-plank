import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import AdminConsole from "@/components/admin/AdminConsole";
import { createPageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

// Not linked from navigation and never indexed — the console is useless
// without an admin wallet signature, but there's no reason to advertise it.
export const metadata = createPageMetadata({
  title: "Admin",
  description: "RobinWood management console.",
  path: "/admin",
  index: false,
});

export default function AdminPage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 px-3 py-6 sm:px-5 sm:py-10"
      >
        {/* data-market-shell: dense app surface — keep the marketing type
            clamps out, exactly like /trade and /market. */}
        <div
          data-market-shell
          className="mx-auto w-full max-w-[1100px] space-y-4 sm:space-y-6"
        >
          <AdminConsole />
        </div>
      </main>
      <Footer />
    </>
  );
}
