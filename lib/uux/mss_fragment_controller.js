/*
 * The copyright in this software module is being made available under the BSD License, included below. This software module may be subject to other third party and/or contributor rights, including patent rights, and no such rights are granted under this license.
 * The whole software resulting from the execution of this software module together with its external dependent software modules from dash.js project may be subject to Orange and/or other third party rights, including patent rights, and no such rights are granted under this license.
 * 
 * Copyright (c) 2014, Orange
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 * •  Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 * •  Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 * •  Neither the name of the Orange nor the names of its contributors may be used to endorse or promote products derived from this software module without specific prior written permission.
 * 
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
uux.MssFragmentController = function () {
    "use strict";

    this.getIndex = function (adaptation, manifest) {
        var periods = manifest.Period_asArray,
            i, j;

        for (i = 0; i < periods.length; i += 1) {
            var adaptations = periods[i].AdaptationSet_asArray;
            for (j = 0; j < adaptations.length; j += 1) {
                if (adaptations[j] === adaptation) {
                    return j;
                }
            }
        }

        return -1;
    };
      
    this.convertFragment = function (data, reference, streamInfo) {
        var i = 0;

        var trackId = 1; // +1 since track_id shall start from '1'

        // Create new fragment
        var fragment = mp4lib.deserialize(data);

        if (!fragment) {
            return null;
        }

        // Get references en boxes
        var moof = fragment.getBoxByType("moof");
        
        if (!moof) {
            return data;
        }
        
        var mdat = fragment.getBoxByType("mdat");
        var traf = moof.getBoxByType("traf");
        var trun = traf.getBoxByType("trun");
        var tfhd = traf.getBoxByType("tfhd");
        var saio;
        
        //if protected content
        var sepiff = traf.getBoxByType("sepiff");
        if(sepiff !== null) {
            sepiff.boxtype = "senc";
            sepiff.extended_type = undefined;
            
            // Remove the existing saio and saiz boxes to re-create them after
            traf.removeBoxByType("saiz");
            traf.removeBoxByType("saio");
            
            // Create Sample Auxiliary Information Offsets Box box (saio) 
            saio = new mp4lib.boxes.SampleAuxiliaryInformationOffsetsBox();
            saio.version = 0;
            saio.flags = 0;
            saio.entry_count = 1;
            saio.offset = [];
            
            var saiz = new mp4lib.boxes.SampleAuxiliaryInformationSizesBox();
            saiz.version = 0;
            saiz.flags = 0;
            saiz.sample_count = sepiff.sample_count;
            saiz.default_sample_info_size = 0;

            saiz.sample_info_size = [];

            var sizedifferent = false;
            // get for each sample_info the size
            if (sepiff.flags & 2) {
                for (i = 0; i < sepiff.sample_count; i++) {
                    saiz.sample_info_size[i] = 8+(sepiff.entry[i].NumberOfEntries*6)+2;
                    //8 (Init vector size) + NumberOfEntries*(clear (2) +crypted (4))+ 2 (numberofEntries size (2))
                    if(i>0) {
                        if (saiz.sample_info_size[i] != saiz.sample_info_size[i-1]) {
                            sizedifferent = true;
                        }
                    }
                }

                //all the samples have the same size
                //set default size and remove the table.
                if (sizedifferent === false) {
                    saiz.default_sample_info_size = saiz.sample_info_size[0];
                    saiz.sample_info_size = [];
                }
            }
            else{
                //if flags === 0 (ex: audio data), default sample size = Init Vector size (8)
                saiz.default_sample_info_size = 8;
            }

            //add saio and saiz box
            traf.boxes.push(saiz);
            traf.boxes.push(saio);
        }

        // Update tfhd.track_ID field
        tfhd.track_ID = 1;

        // Process tfxd boxes
        // This box provide absolute timestamp but we take the segment start time for tfdt
        traf.removeBoxByType("tfxd");

        // Create and add tfdt box
        var tfdt = traf.getBoxByType("tfdt");
        if (tfdt === null) {
            tfdt = new mp4lib.boxes.TrackFragmentBaseMediaDecodeTimeBox();
            tfdt.version = 1;
            tfdt.flags = 0;
            tfdt.baseMediaDecodeTime = Math.floor(reference.id);
            // Insert tfdt box just after the tfhd box (and before the trun box)
            var pos = traf.getBoxPositionByType("tfhd");
            traf.boxes.splice(pos + 1, 0, tfdt);
        }

        // Process tfrf box
        var tfrf = traf.getBoxesByType("tfrf");
        if (tfrf.length !== 0) {
            for (i = 0; i < tfrf.length; i++) {
                //processTfrf(tfrf[i], streamIndex);
                traf.removeBoxByType("tfrf");
            }
        }

        // Before determining new size of the converted fragment we update some box flags related to data offset
        tfhd.flags &= 0xFFFFFE; // set tfhd.base-data-offset-present to false
        tfhd.flags |= 0x020000; // set tfhd.default-base-is-moof to true
        trun.flags |= 0x000001; // set trun.data-offset-present to true
        trun.data_offset = 0;   // Set a default value for trun.data_offset

        // Determine new size of the converted fragment
        // and allocate new data buffer
        var fragment_size = fragment.getLength();

        // updata trun.data_offset field = offset of first data byte (inside mdat box)
        trun.data_offset = fragment_size - mdat.size + 8; // 8 = 'size' + 'type' mdat fields length

        // PATCH tfdt and trun samples timestamp values in case of live streams within chrome
        // if ((navigator.userAgent.indexOf("Chrome") >= 0) && (streamInfo.type === "dynamic")){
        //     tfdt.baseMediaDecodeTime /= 1000;
        //     for  (i = 0; i < trun.samples_table.length; i++) {
        //         if (trun.samples_table[i].sample_composition_time_offset > 0) {
        //             trun.samples_table[i].sample_composition_time_offset /= 1000;
        //         }
        //         if (trun.samples_table[i].sample_duration > 0) {
        //             trun.samples_table[i].sample_duration /= 1000;
        //         }
        //     }
        // }

        if(sepiff !== null) {
            //+8 => box size + type
            var moofpositionInFragment = fragment.getBoxPositionByType("moof")+8;
            var trafpositionInMoof = moof.getBoxPositionByType("traf")+8;
            var sencpositionInTraf = traf.getBoxPositionByType("senc")+8;
            // set offset from begin fragment to the first IV in senc box
            saio.offset[0] = moofpositionInFragment+trafpositionInMoof+sencpositionInTraf + 8;//flags (3) + version (1) + sampleCount (4)
        }
        
        var new_data = mp4lib.serialize(fragment);
        
        // if (reference.id === 0) {
        //   var chunkName = "chunk_merge_" + reference.id + "_" + new Date().getTime() + ".bin";
        //   uux.download(chunkName, new_data);
        // }

        

        return new_data;
    };
};

