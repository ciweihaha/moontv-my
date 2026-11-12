// 该文件由 scripts/convert-config.js 自动生成，请勿手动修改
export const config = {
  "cache_time": 9200,
  "api_site": {
    "agg": {
      "api": "https://ysp.ciweihaha.win/agg",
      "name": "多站合一"
    }
  }
} as const;

export type RuntimeConfig = typeof config;

export default config;
