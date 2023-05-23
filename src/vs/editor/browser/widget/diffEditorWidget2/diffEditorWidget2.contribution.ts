/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from 'vs/base/common/codicons';
import { ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { localize } from 'vs/nls';
import { Action2, MenuId, registerAction2 } from 'vs/platform/actions/common/actions';

export class ToggleCollapseUnchangedRegions extends Action2 {
	constructor() {
		super({
			id: 'diffEditor.toggleCollapseUnchangedRegions',
			title: { value: localize('toggleCollapseUnchangedRegions', "Toggle Collapse Unchanged Regions"), original: 'Toggle Collapse Unchanged Regions' },
			icon: Codicon.map,
			menu: [
				{
					id: MenuId.EditorTitle,
					group: 'navigation',
				}
			]
		});
	}

	run(accessor: ServicesAccessor, ...args: unknown[]): void {

	}
}

registerAction2(ToggleCollapseUnchangedRegions);
