export default [
  {
    id: 'J09', title: '植物体内的水分运输与蒸腾', domain: 'biology', language: 'zh-CN', depth: 'working_fluency',
    goals: ['解释根吸水、木质部运输与叶片蒸腾的联系', '依据给定环境变化判断蒸腾趋势并说明机制', '用水量收支解释植物状态且区分水分与有机物运输'],
    freshness: 'Whole-plant transpiration and water balance, distinct from earlier membrane diffusion, seed experiments and ecosystem energy sources.',
    text: `陆生植物需要把根部吸收的水送到茎和叶。根毛增加根与土壤接触的表面积，有利于从湿润土壤吸收水和溶于水的无机盐。木质部中的导管等结构提供水分向上运输的通路。叶片内的水分蒸发后，水蒸气主要经气孔散失到空气中，这个过程叫蒸腾。蒸腾形成的拉力是水在木质部向上运输的重要动力之一，不是叶片把整滴液态水主动泵到空气中。

气孔由保卫细胞调节开闭。气孔开放有利于二氧化碳进入叶片进行光合作用，同时也提供水蒸气散失的通道。气孔关闭通常会降低这条通道的失水量，但也限制二氧化碳进入。因此不能只把气孔看成无用的漏水孔。植物必须在获取二氧化碳和避免过度失水之间调节；本课不要求计算气孔开度或激素浓度。

比较蒸腾时要写出保持不变的条件。在温度、光照、叶面积、气孔开度和供水相同的情况下，周围空气更干燥，叶内外水蒸气差异通常更大，蒸腾会增强。适度空气流动移走叶面附近较湿的空气，也可增强蒸腾。这里说的是其余条件固定的正常范围比较，不把极端大风或缺水引起的气孔关闭混进同一个条件判断。

例如两株同种且叶面积相近的植物，土壤供水充足，温度、光照、气孔开度相同；甲处在较湿空气，乙处在较干空气。按照给定条件，乙的蒸腾通常更强，因为水蒸气从叶内到外界的扩散驱动力更大。这不是因为乙必然有更多根毛，也不能由该比较直接推出乙一定长得更快。生长还受其他过程影响，本例没有测量生长量。

水分状态可用收支理解：在一段时间内，若根吸水量持续小于叶等部位的失水量，植物体内水量会下降，细胞膨压降低，可能出现萎蔫。若吸水能补足失水，蒸腾增强并不必然导致萎蔫。假设某时段吸水8克、失水11克，忽略其他水量变化，植物体内水量减少3克；若吸水12克、失水11克，则增加1克。水量变化是输入减输出，不是只看蒸腾数值大小。

木质部运输水和无机盐，韧皮部则运输叶等来源器官产生的糖等有机物，运往需要或储存它们的部位。不能把土壤中的水说成植物全部有机养料，也不能把这两套运输组织混为一个功能。完整解释可沿“土壤供水、根吸收、木质部运输、叶蒸发、气孔散失”建立联系，再结合实际给定的环境与收支条件判断。`,
  },
  {
    id: 'J10', title: '有丝分裂中的复制与分配', domain: 'biology', language: 'zh-CN', depth: 'pass_oriented',
    goals: ['区分分裂前DNA复制与随后染色体分配', '按明确计数时点说明母细胞和子细胞的染色体数', '解释正常有丝分裂如何保持遗传信息并计算细胞数'],
    freshness: 'Mitosis, sister chromatids and cell multiplication, distinct from allele segregation in crosses and DNA complement strings.',
    text: `有丝分裂是许多真核生物体细胞增殖的方式。为了让两个子细胞获得完整的遗传信息，细胞先在分裂前的间期复制DNA，随后在有丝分裂过程中分配复制后的染色体，通常再经细胞质分裂形成两个细胞。复制与分配是不同动作：复制增加DNA份数，分配把已经复制的材料送到两个子细胞。

本课用一个正常体细胞作模型：复制前有4条染色体，每条含一个DNA分子。DNA复制后、姐妹染色单体尚未分开时，仍记为4条染色体，每条含两条姐妹染色单体，共8个DNA分子。计数约定是按着丝粒的数目计染色体，姐妹染色单体分开前共享一个着丝粒计数单位。因此“DNA已经加倍”不等于这个时点的染色体数也记成8条。

有丝分裂开始后，染色体凝缩，随后排列在细胞中央附近。姐妹染色单体分离，分别移向两极；每条分开的染色单体此时成为一条独立染色体。在本模型的分离后、细胞质尚未分开这一短暂时点，整个细胞内共有8条染色体，每一极有4条。随后形成两个细胞，每个子细胞各有4条染色体，与复制前母细胞的数目相同。

例如问“分裂完成后，每个子细胞有多少条染色体”，应答4条，不能把两个子细胞合计8条误写成每个8条。若问“复制后但尚未分离时有多少个DNA分子”，答案是整个细胞8个。这两题的对象和时点不同，解答前应明确问的是一个细胞、每一极还是两个细胞的合计，以及复制和分离是否已经发生。

在没有突变、分配错误等异常的本课正常模型中，复制使每条染色体的信息有两份，随后均等分离使每个子细胞各得到一份完整集合，因此子细胞通常与母细胞保持相同的遗传信息。细胞数增加不等于每个细胞的遗传信息必须不断减半。减数分裂形成配子的过程另有规则，不能把它的染色体减半结论套在这里。

若所有细胞都继续完成一轮这样的分裂且没有细胞死亡，每个细胞变成两个，n轮后细胞数为初始数乘2的n次方。例如从1个细胞开始，三轮依次为2、4、8个，每个仍有4条染色体。由2个细胞开始完成两轮，则为2×2×2=8个。轮数不是小时数；未给分裂周期时不能把三轮直接说成三小时。说明过程时依次交代复制、分离与细胞分开，就能避免把DNA份数、染色体条数和细胞个数混在一起。`,
  },
  {
    id: 'J11', title: '英语主动句与被动句的对应', domain: 'language', language: 'zh-CN', depth: 'working_fluency',
    goals: ['识别动作施事、动作和受事并区分语法主语', '在一般现在时与一般过去时之间保持时态地转换主被动句', '按题目要求保留施事与否定等信息并解释表达重点'],
    freshness: 'Active/passive voice with tense and role preservation, distinct from subject-verb agreement, pronoun resolution and concession connectors.',
    text: `英语主动句通常把动作的施事放在主语位置，如“The editor checks the report.”编辑是检查动作的执行者，报告是受到检查的对象。相应被动句为“The report is checked by the editor.”报告成为语法主语，但它仍是动作的受事，并没有变成检查别人的执行者。改变语态可以改变叙述重点，而不必改变所报告的事件。

本课只讨论有明确宾语的及物动词、一般现在时和一般过去时。被动结构为“受事主语 + be的合适形式 + 过去分词”，需要保留施事时加“by + 施事”。本课给定过去分词：check变checked，repair变repaired，write变written，make变made。write和make是不规则变化，不能机械写成writed或maked。

一般现在时根据新的主语选择am、is或are。例如“The workers repair the machines.”改为“The machines are repaired by the workers.”新主语machines为复数，用are；原句描述一般现在的动作，被动句也保持一般现在时。若主动句为“The worker repairs the machine.”则改为“The machine is repaired by the worker.”原主动句的单复数形式不能直接当作被动句be的选择依据。

一般过去时使用was或were。例如“Lena wrote the notice yesterday.”改为“The notice was written by Lena yesterday.”notice为单数，用was；written是write的过去分词，yesterday保留。“They made the signs yesterday.”改为“The signs were made by them yesterday.”by之后的人称代词用宾格，they对应them，he对应him，she对应her，we对应us，I对应me。

否定信息也要保留。“The editor did not check the report.”可改为“The report was not checked by the editor.”主动句did not已经标记一般过去时，被动句用was not，不保留did，也不能漏掉not。“The reports are not checked by Mia.”改回主动句为“Mia does not check the reports.”主语Mia为单数，一般现在时否定用does not加动词原形。

练习若要求完整保留信息，应保留原施事、受事、动作、时态、否定和明确时间语。在真实写作中，施事不重要或未知时可以省略by短语；但若本题要求与已给句子信息完整对应，就不能把“由Lena写”丢掉后声称所有信息都保留了。选择语态取决于要突出谁或什么，不等于被动句永远更正式或更好。

转换时先标出谁做什么、什么受到动作，再移动施事与受事的位置，选择正确的be和过去分词，最后逐项核对信息。像“The child slept.”在本课句子中没有宾语，不属于这个直接转换规则的适用对象。练习提供完整句子和所需动词形式，重点在角色与结构对应，不要求猜测未给出的上下文。`,
  },
  {
    id: 'J12', title: '英语比较级与最高级', domain: 'language', language: 'zh-CN', depth: 'pass_oriented',
    goals: ['区分两者比较与给定集合中的最高程度', '按给定词形规则使用比较级和最高级', '依据完整数据写出比较句并保留比较范围'],
    freshness: 'Comparative/superlative adjective formation and scoped comparison, not earlier prefix negation or agreement exercises.',
    text: `英语比较级用来比较两个对象在某一方面的程度，常配合than；最高级表示某个对象在给定集合中达到最高程度，通常使用the并交代比较范围。例如“This box is lighter than that box.”比较这两个箱子的轻重；“This is the lightest box of the three.”把它放在指定的三个箱子中比较。最高级不是不受范围限制的“世界第一”。

本课使用明确给出的词形。一般短形容词可加-er和-est，例如tall、taller、tallest，small、smaller、smallest。以不发音的e结尾时加-r和-st，例如large、larger、largest。以辅音字母加y结尾时，把y改为i再加-er或-est，例如heavy、heavier、heaviest。不要把heavy写成heavyer。

部分短词要双写末尾辅音，例如big、bigger、biggest。长形容词常用more和most，例如careful、more careful、most careful，expensive、more expensive、most expensive。本课按这些给定词形练习，不要求仅凭字母数推导所有英语词的变化。不能把两套标记叠加，例如more bigger和most tallest在本课标准形式中都不正确。

常见不规则词形也直接给出：good、better、best；bad、worse、worst。例如“A is better than B at this task.”使用better，不是gooder。最高级句可写“A is the best of these three at this task.”但better、best本身只表达给定评价维度上的排序；若没有提供评价依据，不能任意决定哪个对象更好。

现在给出三个箱子的质量：A为2千克，B为5千克，C为8千克，其他质量信息无需猜测。可以写“B is heavier than A.”，因为5大于2；“C is the heaviest of the three boxes.”，因为8在这三者中最大；“A is the lightest of the three boxes.”，因为2最小。若问B是否比C轻，应写“B is lighter than C.”，不能只看到比较句就把heavier套上。

另有三件物品的价格：一本书20元，一支笔5元，一个包30元。给定只比较标价时，可写“The bag is more expensive than the book.”以及“The pen is the least expensive of the three.”least表示最低程度；本课给定less expensive为更便宜，least expensive为最便宜。最贵不自动等于最好，价格数据不能替代质量评价。

写比较句时先确定维度、对象和范围，再用数据决定方向，最后选词形与句式。比较级常用than连接另一对象，最高级应保留of the three、in this group等明确范围。题目提供的都是可直接比较的同单位数值，因此无需自行补充测量条件；读者应能从给定数据和词形规则复核每一句。`,
  },
];
