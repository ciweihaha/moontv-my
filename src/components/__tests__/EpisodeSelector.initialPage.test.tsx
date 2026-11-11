/**
 * 深查第 25 轮：选集初始页越界/非数值钳制。
 * 脏播放记录的 index 为 0/缺失时，播放页 currentEpisodeIndex 为 -1/NaN，
 * 传给选集的 value = index+1 得 0/NaN。旧实现 initialPage 得 -1/NaN：
 * -1 渲染出 -49..0 的负集数按钮，NaN 则集数网格全空。
 * 新行为：非法值按第 1 页，超界按最后一页。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from '@testing-library/react';
import React from 'react';

import EpisodeSelector from '@/components/EpisodeSelector';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

// jsdom 未实现滚动 API，选集组件挂载时会滚动聚焦当前分页
beforeAll(() => {
  Element.prototype.scrollTo = jest.fn() as any;
  Element.prototype.scrollIntoView = jest.fn() as any;
});

function episodeButtons(): string[] {
  return screen
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    .filter((t) => /^-?\d+$/.test(t));
}

describe('EpisodeSelector 初始页钳制（深查第 25 轮）', () => {
  const base = {
    totalEpisodes: 120,
    onChange: jest.fn(),
  };

  it('value=0（脏记录 index 为 0）→ 显示第 1 页 1..50，无负集数（旧实现 -49..0）', () => {
    render(<EpisodeSelector {...base} value={0} />);
    const nums = episodeButtons();
    expect(nums).toHaveLength(50);
    expect(nums[0]).toBe('1');
    expect(nums[49]).toBe('50');
    expect(nums.some((n) => Number(n) < 1)).toBe(false);
  });

  it('value=NaN（脏记录 index 缺失）→ 显示第 1 页（旧实现网格全空）', () => {
    render(<EpisodeSelector {...base} value={NaN} />);
    const nums = episodeButtons();
    expect(nums).toHaveLength(50);
    expect(nums[0]).toBe('1');
  });

  it('value 超界（如 200）→ 显示最后一页 101..120', () => {
    render(<EpisodeSelector {...base} value={200} />);
    const nums = episodeButtons();
    expect(nums).toHaveLength(20);
    expect(nums[0]).toBe('101');
    expect(nums[19]).toBe('120');
  });

  it('正常 value=75 → 显示第 2 页 51..100，且 75 高亮（回归基线）', () => {
    render(<EpisodeSelector {...base} value={75} />);
    const nums = episodeButtons();
    expect(nums).toHaveLength(50);
    expect(nums[0]).toBe('51');
    expect(nums).toContain('75');
  });
});
