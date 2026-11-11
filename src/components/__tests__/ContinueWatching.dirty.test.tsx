/**
 * 深查第 21 轮：继续观看的进度与排序脏数据兜底。
 * 旧实现：total_time 缺失/非数值时 play_time/total_time 得 NaN，
 * VideoCard 渲染出 width: NaN% 的无效样式；play_time 超过 total_time
 * 时进度溢出 100%；save_time 缺失时排序比较器返回 NaN、顺序不稳定。
 * 新行为：缺失/非法按 0，进度夹在 [0, 100]；无 save_time 的记录沉底。
 * VideoCard 用桩替身（只透传 progress），聚焦本组件的计算逻辑。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import ContinueWatching from '@/components/ContinueWatching';

jest.mock('@/components/ScrollableRow', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/VideoCard', () => ({
  __esModule: true,
  default: (props: any) => (
    <div
      data-testid="cw-card"
      data-progress={props.progress}
      data-title={props.title}
    />
  ),
}));

const mockGetAllPlayRecords = jest.fn();
jest.mock('@/lib/db.client', () => ({
  clearAllPlayRecords: jest.fn(),
  getAllPlayRecords: (...args: any[]) => mockGetAllPlayRecords(...args),
  subscribeToDataUpdates: jest.fn(() => () => {}),
}));

function record(overrides: Record<string, unknown> = {}) {
  return {
    title: '片',
    source_name: '源1',
    cover: 'https://img.example.com/pic.jpg',
    year: '2024',
    index: 1,
    total_episodes: 10,
    play_time: 30,
    total_time: 100,
    save_time: 1000,
    search_title: '片',
    ...overrides,
  };
}

describe('ContinueWatching 脏记录兜底（深查第 21 轮）', () => {
  beforeEach(() => {
    mockGetAllPlayRecords.mockReset();
  });

  test('total_time 缺失/0、play_time 缺失 → 进度 0（旧实现 NaN%）', async () => {
    mockGetAllPlayRecords.mockResolvedValue({
      's1+1': record({ title: '缺总量', total_time: undefined, save_time: 3 }),
      's1+2': record({ title: '零总量', total_time: 0, save_time: 2 }),
      's1+3': record({ title: '缺已播', play_time: undefined, save_time: 1 }),
    });
    render(<ContinueWatching />);
    await waitFor(() =>
      expect(screen.getAllByTestId('cw-card')).toHaveLength(3)
    );
    const progresses = screen
      .getAllByTestId('cw-card')
      .map((el) => el.getAttribute('data-progress'));
    expect(progresses).toEqual(['0', '0', '0']);
    progresses.forEach((p) => expect(p).not.toBe('NaN'));
  });

  test('play_time 超过 total_time → 夹到 100；负值 → 夹到 0；正常值不变', async () => {
    mockGetAllPlayRecords.mockResolvedValue({
      's1+1': record({ title: '超量', play_time: 150, total_time: 100, save_time: 3 }),
      's1+2': record({ title: '负值', play_time: -5, total_time: 100, save_time: 2 }),
      's1+3': record({ title: '正常', play_time: 30, total_time: 100, save_time: 1 }),
    });
    render(<ContinueWatching />);
    await waitFor(() =>
      expect(screen.getAllByTestId('cw-card')).toHaveLength(3)
    );
    const byTitle = Object.fromEntries(
      screen
        .getAllByTestId('cw-card')
        .map((el) => [
          el.getAttribute('data-title'),
          el.getAttribute('data-progress'),
        ])
    );
    expect(byTitle).toEqual({ 超量: '100', 负值: '0', 正常: '30' });
  });

  test('save_time 缺失的记录沉底（旧实现 NaN 比较、顺序不稳定）', async () => {
    mockGetAllPlayRecords.mockResolvedValue({
      's1+1': record({ title: '无时间', save_time: undefined }),
      's1+2': record({ title: '旧', save_time: 100 }),
      's1+3': record({ title: '新', save_time: 200 }),
    });
    render(<ContinueWatching />);
    await waitFor(() =>
      expect(screen.getAllByTestId('cw-card')).toHaveLength(3)
    );
    const titles = screen
      .getAllByTestId('cw-card')
      .map((el) => el.getAttribute('data-title'));
    expect(titles).toEqual(['新', '旧', '无时间']);
  });
});
