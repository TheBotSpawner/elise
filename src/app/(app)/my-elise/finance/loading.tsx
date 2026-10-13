import { PageContainer } from "@/components/shared/page";

/** Finance loads as its own shape (never an empty state that turns into data). */
export default function FinanceLoading() {
  const block = "animate-pulse rounded-2xl bg-surface-2/70";
  return (
    <PageContainer wide>
      <div aria-busy="true" className="flex flex-col gap-5">
        <div className={`${block} h-10 w-48`} />
        <div className="flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`${block} h-8 w-24 rounded-full`} />
          ))}
        </div>
        <div className={`${block} h-11 w-full max-w-xl`} />
        <div className={`${block} h-24 w-full`} />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={`${block} h-14 w-full`} />
            ))}
          </div>
          <div className={`${block} hidden h-64 xl:block`} />
        </div>
      </div>
    </PageContainer>
  );
}
