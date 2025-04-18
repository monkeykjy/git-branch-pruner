# Git Branch Pruner

一个帮助你管理和清理 Git 分支的 VS Code 扩展。

[English](README_EN.md) | 简体中文

## 功能特性

- 📊 可视化展示所有本地分支状态
- 🔄 显示分支与远程仓库的同步状态
- 🗑️ 轻松删除已合并或已在远程删除的分支
- 🔍 清晰标识当前分支和主分支
- 🌏 支持中文和英文界面

## 使用方法

1. 在 VS Code 中打开一个 Git 仓库
2. 点击活动栏中的 Git Branch Pruner 图标
3. 查看分支列表和状态
4. 选择要删除的分支，点击"删除选中"按钮

## 分支状态说明

- ✓ 远程：分支在远程仓库中存在
- ✗ 远程：分支在远程仓库中不存在
- 当前：当前检出的分支
- 主分支：main 或 master 分支

## 系统要求

- VS Code 1.80.0 或更高版本
- Git 2.0.0 或更高版本

## 注意事项

- 删除操作仅影响本地分支，不会删除远程分支
- 建议在删除分支前先确保相关更改已合并
- 主分支（main/master）默认不允许删除

## 问题反馈

如果您遇到问题或有建议，欢迎在 [GitHub Issues](https://github.com/monkeykjy/git-branch-pruner/issues) 中提出。

## 更新日志

详见 [CHANGELOG.md](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
