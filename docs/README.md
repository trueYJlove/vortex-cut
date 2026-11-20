# 文档入口

项目文档按两个主题查找：**需求**与**设计**。除 [STATUS.md](STATUS.md) 外，项目文档均归入这两个目录；当前状态只看 STATUS.md。可追溯的实验材料见仓库根目录的 `evidence/`。

## 新读者阅读顺序

1. 仓库根目录的 [README](../README.md)：产品介绍、开发环境和常用命令。
2. [STATUS.md](STATUS.md)：当前工作线、能力边界和未关闭承诺。先看 §2–§3；§4 未闭环项在前，已核销历史行折叠在表格下方。
3. [系统架构](../ARCHITECTURE.md)：进程边界、核心模块和数据流。
4. [用户手册](requirements/VORTEX_CUT_USER_MANUAL.md)：从用户视角了解编辑器操作。
5. 按当前要做的工作再看[需求索引](requirements/README.md)和[设计索引](design/README.md)。

通常不需要从头阅读阶段记录。只有在追溯某个决策、复核一次验收或复跑测量时，才进入[设计记录](design/records/README.md)或 `evidence/`。

## 两类文档

- [需求](requirements/README.md)：产品目标、用户行为、边界与验收标准。
- [设计](design/README.md)：架构、决策、交互与技术方案；实施、验收和验证快照放在设计类的记录子目录。

## 查找约定

- 设计与验收记录可能包含当时的状态快照；不要据此推断当前状态，先查 [STATUS.md](STATUS.md)。
- `evidence/` 保存被状态、决策或验收引用的依据。清理前先核对引用与未关闭承诺。
- `docs/requirements/` 与 `docs/design/` 是两类内容的唯一归档位置；细分目录只服务于主题查找，不增加文档大类。
- 阶段记录经提炼后，确认无未关闭承诺、有效引用或独立证据价值，才删除。
