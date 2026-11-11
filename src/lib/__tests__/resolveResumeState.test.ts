/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 深查第 26 轮：续播状态解析——脏记录的 index 不恢复选集与进度。
 * 旧实现 `record.index - 1` 不校验：index 为 0 得 -1、缺失/非数值得
 * NaN，播放页直接 setCurrentEpisodeIndex(-1/NaN)，updateVideoUrl 的
 * 越界守卫拦不住（-1/NaN >= length 为 false），episodes[-1/NaN] 得
 * undefined → 视频地址置空、无法播放。
 */
import { resolveResumeState } from '@/lib/utils';

describe('resolveResumeState', () => {
  it('正常记录：第 3 集 + 120 秒', () => {
    expect(resolveResumeState({ index: 3, play_time: 120 })).toEqual({
      episodeIndex: 2,
      resumeTime: 120,
    });
  });

  it('第 1 集 + 无进度 → 集 0、resumeTime null', () => {
    expect(resolveResumeState({ index: 1 })).toEqual({
      episodeIndex: 0,
      resumeTime: null,
    });
  });

  it('index 为 0 → null（旧实现选集 -1，视频地址置空）', () => {
    expect(resolveResumeState({ index: 0, play_time: 50 })).toBeNull();
  });

  it('index 缺失/非数值 → null（旧实现选集 NaN）', () => {
    expect(resolveResumeState({ play_time: 50 })).toBeNull();
    expect(resolveResumeState({ index: undefined, play_time: 50 })).toBeNull();
    expect(resolveResumeState({ index: '3' as any, play_time: 50 })).toBeNull();
    expect(resolveResumeState({ index: NaN, play_time: 50 })).toBeNull();
    expect(resolveResumeState({ index: 2.5, play_time: 50 })).toBeNull();
    expect(resolveResumeState({ index: -2, play_time: 50 })).toBeNull();
  });

  it('index 合法但 play_time 缺失/非数值 → 只恢复集数，时间 null', () => {
    expect(resolveResumeState({ index: 2 })).toEqual({
      episodeIndex: 1,
      resumeTime: null,
    });
    expect(resolveResumeState({ index: 2, play_time: '90' as any })).toEqual({
      episodeIndex: 1,
      resumeTime: null,
    });
  });
});
