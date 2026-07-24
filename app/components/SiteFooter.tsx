import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-zinc-800 pt-10">
      <div className="page-gutter">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-12">
          <div className="flex flex-col gap-2 lg:w-[35%] lg:shrink-0">
            <Link
              href="/"
              className="text-base font-semibold tracking-tight text-zinc-100 transition-colors hover:text-orange-400"
            >
              Reddit Alpha
            </Link>
            <p className="max-w-[16rem] text-sm leading-relaxed text-zinc-500">
              实时追踪 Reddit 热门股票讨论，结合技术信号给出建仓/平仓提醒。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-12 gap-y-8 sm:grid-cols-3 lg:flex-1">
            <div>
              <h3 className="text-sm font-medium text-zinc-200">导航</h3>
              <ul className="mt-3 flex flex-col gap-2.5">
                <li>
                  <Link
                    href="/"
                    className="text-sm text-zinc-500 transition-colors duration-200 hover:text-zinc-100"
                  >
                    首页
                  </Link>
                </li>
                <li>
                  <Link
                    href="/signals"
                    className="text-sm text-zinc-500 transition-colors duration-200 hover:text-zinc-100"
                  >
                    信号提醒
                  </Link>
                </li>
                <li>
                  <Link
                    href="/admin"
                    className="text-sm text-zinc-500 transition-colors duration-200 hover:text-zinc-100"
                  >
                    后台
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-medium text-zinc-200">数据来源</h3>
              <ul className="mt-3 flex flex-col gap-2.5">
                <li>
                  <span className="text-sm text-zinc-500">Reddit</span>
                </li>
                <li>
                  <span className="text-sm text-zinc-500">TradingView</span>
                </li>
                <li>
                  <span className="text-sm text-zinc-500">同花顺</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-zinc-800 pt-5">
          <p className="text-xs text-zinc-600">
            © {new Date().getFullYear()} Reddit Alpha · 仅供学习研究，不构成投资建议
          </p>
        </div>
      </div>
    </footer>
  );
}
