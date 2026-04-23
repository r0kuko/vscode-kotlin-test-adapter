## Overview

这个仓库是 Visual Studio Code 的一个扩展，用于 Kotlin 测试适配。

可能需要基于 kotlin-lsp 来实现测试识别。

我希望不仅要接入比较简单的 JUnit 4/5，还要接入一些其他的测试框架，比如 Spek、Kotest 等等（后续计划）。

还希望支持识别 gradle modules 中的单元测试。

最主要的是接入 https://github.com/hbenl/vscode-test-explorer 来实现测试的展示和运行。
其他可用于参考的项目有 https://github.com/kondratyev-nv/vscode-python-test-adapter 和其他相关项目。

可能需要初始化一个 gradle kotlin 项目用于测试识别。