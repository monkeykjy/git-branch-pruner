/**
 * Git分支信息接口
 */
export interface Branch {
  /** 分支名称 */
  name: string;
  /** 是否为本地分支 */
  isLocal: boolean;
  /** 分支存在状态 */
  exists: {
    /** 是否存在于本地 */
    local: boolean;
    /** 是否存在于远程 */
    remote: boolean;
  };
  /** 是否为当前检出的分支 */
  isCurrentBranch: boolean;
  /** 是否为主分支（main/master） */
  isMainBranch: boolean;
}
