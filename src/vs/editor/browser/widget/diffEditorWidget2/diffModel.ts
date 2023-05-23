/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { IObservable, IReader, ITransaction, observableFromEvent, observableSignalFromEvent, observableValue, transaction } from 'vs/base/common/observable';
import { autorunWithStore2 } from 'vs/base/common/observableImpl/autorun';
import { LineRange } from 'vs/editor/common/core/lineRange';
import { IDocumentDiff, IDocumentDiffProvider } from 'vs/editor/common/diff/documentDiffProvider';
import { LineRangeMapping } from 'vs/editor/common/diff/linesDiffComputer';
import { IDiffEditorModel } from 'vs/editor/common/editorCommon';

export class DiffModel extends Disposable {
	private readonly _isDiffUpToDate = observableValue<boolean>('isDiffUpToDate', false);
	public readonly isDiffUpToDate: IObservable<boolean> = this._isDiffUpToDate;

	private readonly _diff = observableValue<IDocumentDiff | undefined>('diff', undefined);
	public readonly diff: IObservable<IDocumentDiff | undefined> = this._diff;

	private readonly _unchangedRegions = observableValue<{ regions: UnchangedRegion[]; originalDecorationIds: string[]; modifiedDecorationIds: string[] }>('unchangedRegion', { regions: [], originalDecorationIds: [], modifiedDecorationIds: [] });
	public readonly unchangedRegions: IObservable<UnchangedRegion[]> = this._unchangedRegions.map(e => e.regions);

	constructor(
		model: IDiffEditorModel,
		ignoreTrimWhitespace: IObservable<boolean>,
		maxComputationTimeMs: IObservable<number>,
		documentDiffProvider: IDocumentDiffProvider,
	) {
		super();

		const modifiedVersionId = observableFromEvent(e => model.modified.onDidChangeContent(e), () => model.modified.getVersionId());
		const originalVersionId = observableFromEvent(e => model.original.onDidChangeContent(e), () => model.original.getVersionId());
		const documentDiffProviderOptionChanged = observableSignalFromEvent('documentDiffProviderOptionChanged', documentDiffProvider.onDidChange);

		this._register(autorunWithStore2('compute diff', (reader, store) => {
			modifiedVersionId.read(reader);
			originalVersionId.read(reader);
			documentDiffProviderOptionChanged.read(reader);
			const ignoreTrimWhitespaceVal = ignoreTrimWhitespace.read(reader);
			const maxComputationTimeMsVal = maxComputationTimeMs.read(reader);

			this._isDiffUpToDate.set(false, undefined);

			const cancellationTokenSrc = new CancellationTokenSource();
			store.add(toDisposable(() => cancellationTokenSrc.dispose(true)));

			timeout(1000, cancellationTokenSrc.token).then(async () => {
				const result = await documentDiffProvider.computeDiff(model.original, model.modified, {
					ignoreTrimWhitespace: ignoreTrimWhitespaceVal,
					maxComputationTimeMs: maxComputationTimeMsVal,
				});

				if (cancellationTokenSrc.token.isCancellationRequested) {
					return;
				}

				const newUnchangedRegions = UnchangedRegion.fromDiffs(result.changes, model.original.getLineCount(), model.modified.getLineCount());

				// Transfer state from cur state
				const lastUnchangedRegions = this._unchangedRegions.get();
				const lastUnchangedRegionsOrigRanges = lastUnchangedRegions.originalDecorationIds
					.map(id => model.original.getDecorationRange(id))
					.filter(r => !!r)
					.map(r => LineRange.fromRange(r!));
				const lastUnchangedRegionsModRanges = lastUnchangedRegions.modifiedDecorationIds
					.map(id => model.modified.getDecorationRange(id))
					.filter(r => !!r)
					.map(r => LineRange.fromRange(r!));

				for (const r of newUnchangedRegions) {
					for (let i = 0; i < lastUnchangedRegions.regions.length; i++) {
						if (r.originalRange.intersectsStrict(lastUnchangedRegionsOrigRanges[i])
							&& r.modifiedRange.intersectsStrict(lastUnchangedRegionsModRanges[i])) {
							r.setState(
								lastUnchangedRegions.regions[i].visibleLineCountTop.get(),
								lastUnchangedRegions.regions[i].visibleLineCountBottom.get(),
								undefined,
							);
							break;
						}
					}
				}

				const originalDecorationIds = model.original.deltaDecorations(
					lastUnchangedRegions.originalDecorationIds,
					newUnchangedRegions.map(r => ({ range: r.originalRange.toInclusiveRange()!, options: { description: 'unchanged' } }))
				);
				const modifiedDecorationIds = model.modified.deltaDecorations(
					lastUnchangedRegions.modifiedDecorationIds,
					newUnchangedRegions.map(r => ({ range: r.modifiedRange.toInclusiveRange()!, options: { description: 'unchanged' } }))
				);

				transaction(tx => {
					this._diff.set(result, tx);
					this._isDiffUpToDate.set(true, tx);

					this._unchangedRegions.set(
						{
							regions: newUnchangedRegions,
							originalDecorationIds,
							modifiedDecorationIds
						},
						tx
					);
				});

			});
		}));
	}

	public revealModifiedLine(lineNumber: number, tx: ITransaction): void {
		const unchangedRegions = this._unchangedRegions.get().regions;
		for (const r of unchangedRegions) {
			if (r.getHiddenModifiedRange(undefined).contains(lineNumber)) {
				r.showAll(tx); // TODO only unhide what is needed
				return;
			}
		}
	}

	public revealOriginalLine(lineNumber: number, tx: ITransaction): void {
		const unchangedRegions = this._unchangedRegions.get().regions;
		for (const r of unchangedRegions) {
			if (r.getHiddenOriginalRange(undefined).contains(lineNumber)) {
				r.showAll(tx); // TODO only unhide what is needed
				return;
			}
		}
	}
}

export class UnchangedRegion {
	public static fromDiffs(changes: LineRangeMapping[], originalLineCount: number, modifiedLineCount: number): UnchangedRegion[] {
		const inversedMappings = LineRangeMapping.inverse(changes, originalLineCount, modifiedLineCount);
		const result: UnchangedRegion[] = [];

		const minHiddenLineCount = 3;
		const minContext = 3;

		for (const mapping of inversedMappings) {
			let origStart = mapping.originalRange.startLineNumber;
			let modStart = mapping.modifiedRange.startLineNumber;
			let length = mapping.originalRange.length;

			if (origStart === 1 && length > minContext + minHiddenLineCount) {
				length -= minContext;
				result.push(new UnchangedRegion(origStart, modStart, length, 0, 0));
			} else if (origStart + length === originalLineCount + 1 && length > minContext + minHiddenLineCount) {
				origStart += minContext;
				modStart += minContext;
				length -= minContext;
				result.push(new UnchangedRegion(origStart, modStart, length, 0, 0));
			} else if (length > minContext * 2 + minHiddenLineCount) {
				origStart += minContext;
				modStart += minContext;
				length -= minContext * 2;
				result.push(new UnchangedRegion(origStart, modStart, length, 0, 0));
			}
		}

		return result;
	}

	public get originalRange(): LineRange {
		return LineRange.ofLength(this.originalLineNumber, this.lineCount);
	}

	public get modifiedRange(): LineRange {
		return LineRange.ofLength(this.modifiedLineNumber, this.lineCount);
	}

	private readonly _visibleLineCountTop = observableValue<number>('visibleLineCountTop', 0);
	public readonly visibleLineCountTop: IObservable<number> = this._visibleLineCountTop;

	private readonly _visibleLineCountBottom = observableValue<number>('visibleLineCountBottom', 0);
	public readonly visibleLineCountBottom: IObservable<number> = this._visibleLineCountBottom;

	constructor(
		public readonly originalLineNumber: number,
		public readonly modifiedLineNumber: number,
		public readonly lineCount: number,
		visibleLineCountTop: number,
		visibleLineCountBottom: number,
	) {
		this._visibleLineCountTop.set(visibleLineCountTop, undefined);
		this._visibleLineCountBottom.set(visibleLineCountBottom, undefined);
	}

	public getHiddenOriginalRange(reader: IReader | undefined): LineRange {
		return LineRange.ofLength(
			this.originalLineNumber + this._visibleLineCountTop.read(reader),
			this.lineCount - this._visibleLineCountTop.read(reader) - this._visibleLineCountBottom.read(reader),
		);
	}

	public getHiddenModifiedRange(reader: IReader | undefined): LineRange {
		return LineRange.ofLength(
			this.modifiedLineNumber + this._visibleLineCountTop.read(reader),
			this.lineCount - this._visibleLineCountTop.read(reader) - this._visibleLineCountBottom.read(reader),
		);
	}

	public showMoreAbove(tx: ITransaction | undefined): void {
		const maxVisibleLineCountTop = this.lineCount - this._visibleLineCountBottom.get();
		this._visibleLineCountTop.set(Math.min(this._visibleLineCountTop.get() + 10, maxVisibleLineCountTop), tx);
	}

	public showMoreBelow(tx: ITransaction | undefined): void {
		const maxVisibleLineCountBottom = this.lineCount - this._visibleLineCountTop.get();
		this._visibleLineCountBottom.set(Math.min(this._visibleLineCountBottom.get() + 10, maxVisibleLineCountBottom), tx);
	}

	public showAll(tx: ITransaction | undefined): void {
		this._visibleLineCountBottom.set(this.lineCount - this._visibleLineCountTop.get(), tx);
	}

	public setState(visibleLineCountTop: number, visibleLineCountBottom: number, tx: ITransaction | undefined): void {
		visibleLineCountTop = Math.min(visibleLineCountTop, this.lineCount);
		visibleLineCountBottom = Math.min(visibleLineCountBottom, this.lineCount - visibleLineCountTop);

		this._visibleLineCountTop.set(visibleLineCountTop, tx);
		this._visibleLineCountBottom.set(visibleLineCountBottom, tx);
	}
}
