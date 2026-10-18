'use client';

// R6-S1: 全局错误边界，页面崩溃时显示友好提示而非白屏
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white px-4">
      <h2 className="text-xl font-bold mb-2">页面出错了</h2>
      <p className="text-gray-400 text-sm mb-6 text-center">
        {error.message || '未知错误，请稍后重试'}
      </p>
      <button
        onClick={reset}
        className="px-6 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
      >
        重新加载
      </button>
    </div>
  );
}
