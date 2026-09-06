import Link from "next/link";
import { SearchBar } from "@/components/SearchBar";
import { ChannelCard } from "@/components/ChannelCard";
import { listCategories, searchChannels } from "@/lib/api";
import { categoryLabel } from "@/lib/format";
import type { CategoryOut, ChannelSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let categories: CategoryOut[] = [];
  let channels: ChannelSummary[] = [];
  let backendDown = false;

  try {
    [categories, channels] = await Promise.all([
      listCategories(),
      searchChannels("news", 12),
    ]);
  } catch {
    backendDown = true;
  }

  return (
    <div className="mx-auto max-w-3xl pt-6 sm:pt-10">
      <div className="mb-2 font-mono text-xs text-accent">
        Telegram Search Engine · Uzbekistan live preview
      </div>
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-fg-bright sm:text-4xl">
        Telegram kanallarini topish va tahlil qilish
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
        Public Telegram preview orqali real kanallar va oxirgi postlar yig‘iladi.
        MTProto foydalanuvchi akkaunti talab qilinmaydi.
      </p>

      <div className="mt-7">
        <SearchBar size="lg" autoFocus />
      </div>

      <div className="mt-12">
        <div className="mb-3 flex items-center justify-between">
          <span className="mono-label">real kanallar</span>
          <Link href="/search?q=news" className="font-mono text-xs text-muted hover:text-accent">
            barchasi →
          </Link>
        </div>

        {backendDown ? (
          <div className="panel px-4 py-6 font-mono text-xs text-danger">
            backend offline
          </div>
        ) : channels.length === 0 ? (
          <div className="panel px-4 py-6 font-mono text-xs text-muted">
            kanal ma’lumotlari hali yig‘ilmagan
          </div>
        ) : (
          <div className="space-y-3">
            {channels.map((channel, index) => (
              <ChannelCard key={channel.id} channel={channel} rank={index + 1} />
            ))}
          </div>
        )}
      </div>

      {categories.length > 0 && (
        <div className="mt-12">
          <div className="mb-3 flex items-center justify-between">
            <span className="mono-label">kategoriyalar</span>
            <Link href="/categories" className="font-mono text-xs text-muted hover:text-accent">
              barchasi →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {categories.map((category) => (
              <Link
                key={category.category}
                href={`/categories#${category.category}`}
                className="panel flex items-center justify-between px-3 py-2.5 transition-colors hover:border-border-bright hover:bg-surface-2/60"
              >
                <span className="text-sm text-fg">{categoryLabel(category.category)}</span>
                <span className="font-mono text-xs text-muted">{category.channel_count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
