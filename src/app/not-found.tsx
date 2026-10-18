// R6-U1: 404 页面，替代 Next.js 默认英文 404
import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white px-4">
      <h2 className="text-2xl font-bold mb-2">404</h2>
      <p className="text-gray-400 text-sm mb-6">页面不存在</p>
      <Link
        href="/"
        className="px-6 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
      >
        返回首页
      </Link>
    </div>
  );
}
